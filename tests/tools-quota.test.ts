import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost as search } from '../functions/api/tools/search'
import { onRequestGet as fetchPage } from '../functions/api/tools/fetch'

/**
 * 限流时机是这次评审的重点：预检只读，上游成功之后才计数。
 * 这里用一个内存 D1 桩跑真实 handler，验的是「失败不吃额度、成功才扣一次」。
 */

const USER_ID = 'user-1'
const ORIGIN = 'https://ds-chat.test'

type LimitRow = { count: number; reset_at: number }

/** 只实现这几个 handler 用到的那几条 SQL，够用即可 */
const makeDb = (limits = new Map<string, LimitRow>()) => {
  const now = () => Math.floor(Date.now() / 1000)
  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      const countUp = () => {
        // bind(key, resetAt, now, now, resetAt)
        const key = String(args[0])
        const current = limits.get(key)
        const next =
          !current || current.reset_at <= now()
            ? { count: 1, reset_at: Number(args[1]) }
            : { count: current.count + 1, reset_at: current.reset_at }
        limits.set(key, next)
        return next.count
      }
      const statement = {
        bind(...next: unknown[]) {
          args = next
          return statement
        },
        async first<T>() {
          if (sql.startsWith('SELECT s.expires_at')) {
            return { expires_at: now() + 600, id: USER_ID, email: 'a@b.test' } as T
          }
          if (sql.startsWith('SELECT count, reset_at')) {
            const row = limits.get(String(args[0]))
            return (row ? { count: row.count, reset_at: row.reset_at } : null) as T | null
          }
          // takeRateLimit 的计数走 INSERT ... RETURNING count，所以计数逻辑挂在 first 上
          if (sql.startsWith('INSERT INTO rate_limits')) {
            return { count: countUp() } as T
          }
          return null
        },
        async run() {
          if (sql.startsWith('INSERT INTO rate_limits')) {
            countUp()
          }
          return { success: true }
        },
      }
      return statement
    },
  }
  return { db: db as unknown as D1Database, limits }
}

const env = (db: D1Database) => ({ DB: db, KEENABLE_BASE: 'https://keenable.test' }) as never

const authHeaders = (extra: Record<string, string> = {}) => ({
  cookie: '__Host-ds_chat_session=token',
  ...extra,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('搜索代理的额度记账', () => {
  it('上游 503 时不计数', async () => {
    const { db, limits } = makeDb()
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }))
    const response = await search({
      request: new Request(`${ORIGIN}/api/tools/search`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ query: 'deepseek' }),
      }),
      env: env(db),
    })
    expect(response.status).toBe(503)
    expect(limits.size).toBe(0)
  })

  it('上游成功之后小时桶和分钟桶各记一次', async () => {
    const { db, limits } = makeDb()
    vi.stubGlobal('fetch', async () =>
      Response.json({ results: [{ url: 'https://a.test/', title: 'A' }] })
    )
    const response = await search({
      request: new Request(`${ORIGIN}/api/tools/search`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ query: 'deepseek' }),
      }),
      env: env(db),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      query: 'deepseek',
      results: [{ title: 'A', url: 'https://a.test/', snippet: '' }],
    })
    expect(limits.get(`tools:search:hour:${USER_ID}`)?.count).toBe(1)
    expect(limits.get(`tools:search:min:${USER_ID}`)?.count).toBe(1)
  })

  it('分钟桶已满时直接 429，不打上游', async () => {
    const limits = new Map<string, LimitRow>([
      [`tools:search:min:${USER_ID}`, { count: 10, reset_at: Math.floor(Date.now() / 1000) + 30 }],
    ])
    const { db } = makeDb(limits)
    const upstream = vi.fn()
    vi.stubGlobal('fetch', async () => {
      upstream()
      return Response.json({ results: [] })
    })
    const response = await search({
      request: new Request(`${ORIGIN}/api/tools/search`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ query: 'deepseek' }),
      }),
      env: env(db),
    })
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ code: 'user_rate' })
    expect(upstream).not.toHaveBeenCalled()
  })
})

describe('抓取代理的额度记账', () => {
  it('上游 429 时不计数，也不记成用户的错', async () => {
    const { db, limits } = makeDb()
    vi.stubGlobal('fetch', async () => new Response('slow down', { status: 429 }))
    const response = await fetchPage({
      request: new Request(
        `${ORIGIN}/api/tools/fetch?url=${encodeURIComponent('https://example.com/')}`,
        {
          headers: authHeaders(),
        }
      ),
      env: env(db),
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'upstream_quota' })
    expect(limits.size).toBe(0)
  })

  it('上游成功之后才计数，正文按上限截断', async () => {
    const { db, limits } = makeDb()
    vi.stubGlobal('fetch', async () =>
      Response.json({ title: 'Example Domain', content: 'x'.repeat(9000) })
    )
    const response = await fetchPage({
      request: new Request(
        `${ORIGIN}/api/tools/fetch?url=${encodeURIComponent('https://example.com/')}`,
        {
          headers: authHeaders(),
        }
      ),
      env: env(db),
    })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { content: string; truncated: boolean }
    expect(payload.content).toHaveLength(8000)
    expect(payload.truncated).toBe(true)
    expect(limits.get(`tools:fetch:hour:${USER_ID}`)?.count).toBe(1)
    expect(limits.get(`tools:fetch:min:${USER_ID}`)?.count).toBe(1)
  })
})
