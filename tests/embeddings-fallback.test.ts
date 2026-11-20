import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

/**
 * 向量接口换路：主路是同源 Pages Function，失败后换 cloudflared 隧道再试一次。
 *
 * 顺序是 2026-11-20 定的：用户在手机上打开 `emb.openfan.dpdns.org` 直接被
 * ERR_CONNECTION_RESET，公网直连那条不可用；同源跟聊天同一条腿，手机上必然可达。
 * 隧道那跳本机推理快（0.1 秒级），给召回当回退，预算 2.5 秒。
 *
 * 这里用假 fetch 覆盖这些分支：不 mock `memory/api` 本身，跑的是真实实现。
 */
const rows = new Map<string, Record<string, unknown>>()

vi.mock('../src/services/chat/db', () => ({
  loadMemory: async (id: string) => rows.get(id),
  putMemory: async (entry: Record<string, unknown>) => {
    rows.set(entry.id as string, entry)
  },
  loadMemories: async () => [...rows.values()],
  loadMemoryProfile: async () => undefined,
  saveMemoryProfile: async () => {},
  clearMemories: async () => rows.clear(),
  openDB: async () => ({}),
}))

const api = await import('../src/services/memory/api')
const { EMBEDDINGS_VIA_TUNNEL, EMBEDDINGS_PUBLIC } = api
/** 主路：同源 Pages Function */
const SAME_ORIGIN = '/api/embeddings'
const { saveMemory } = await import('../src/services/memory/store')
const { memoryActionBlocks } = await import('../src/services/chat/toolBlocks')

type Call = { url: string; body: string }

let calls: Call[] = []

/** 一次成功的向量响应：维度 2，方便断言 */
const okResponse = () =>
  new Response(JSON.stringify({ vectors: [[1, 0]], dim: 2, model: 'fake' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const installFetch = (handler: (url: string) => Promise<Response> | Response | 'throw') => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/api/auth/token')) {
        return new Response(JSON.stringify({ token: 'tk' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      calls.push({ url, body: String(init?.body ?? '') })
      const outcome = await handler(url)
      if (outcome === 'throw') {
        throw new TypeError('Failed to fetch')
      }
      return outcome
    })
  )
}

beforeEach(() => {
  rows.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('写入路径的换路', () => {
  it('同源不通时换隧道，记忆照样存下，动作记录仍是「已记住 1 条」', async () => {
    installFetch((url) => (url === SAME_ORIGIN ? 'throw' : okResponse()))

    const result = await saveMemory({ content: '最爱吃芒果布丁', tags: [], sessionId: 's1' })

    expect(result.ok).toBe(true)
    const blocks = memoryActionBlocks('call-1', 'save', true)
    expect(blocks[0]).toMatchObject({ type: 'memory_action', action: 'save', count: 1 })
    // 真的换了路：先同源、后隧道，两条都发过；直连那条不再使用
    expect(calls.map((call) => call.url)).toEqual([SAME_ORIGIN, EMBEDDINGS_VIA_TUNNEL])
    expect(calls.every((call) => call.url !== EMBEDDINGS_PUBLIC)).toBe(true)
    // 落库了，而且块里没有正文
    expect([...rows.values()]).toHaveLength(1)
    expect(JSON.stringify(blocks)).not.toContain('芒果布丁')
  })

  it('同源 5xx 也换隧道', async () => {
    installFetch((url) => (url === SAME_ORIGIN ? new Response('bad gateway', { status: 502 }) : okResponse()))

    const result = await saveMemory({ content: '咖啡只喝冰美式', tags: [], sessionId: 's1' })

    expect(result.ok).toBe(true)
    expect(calls.map((call) => call.url)).toEqual([SAME_ORIGIN, EMBEDDINGS_VIA_TUNNEL])
  })

  it('两条都失败才算失败，reason 仍是 embed_failed', async () => {
    installFetch(() => 'throw')

    const result = await saveMemory({ content: '地铁上的一条记忆', tags: [], sessionId: 's1' })

    expect(result).toMatchObject({ ok: false, reason: 'embed_failed' })
    expect(calls.map((call) => call.url)).toEqual([SAME_ORIGIN, EMBEDDINGS_VIA_TUNNEL])
    expect(rows.size).toBe(0)
  })

  it('401 不换路：同一张票换到隧道也一样是 401', async () => {
    installFetch(() => new Response('unauthorized', { status: 401 }))

    const result = await saveMemory({ content: '不该重试的那条', tags: [], sessionId: 's1' })

    expect(result).toMatchObject({ ok: false, reason: 'embed_failed' })
    expect(calls.map((call) => call.url)).toEqual([SAME_ORIGIN])
  })

  it('写入那一跳的预算还是 6 秒', () => {
    expect(api.WRITE_TIMEOUT_MS).toBe(6000)
  })
})

describe('召回路径的换路', () => {
  it('主路不通时换隧道，用的是隧道那条自己的 2.5 秒预算', async () => {
    installFetch((url) => (url === SAME_ORIGIN ? 'throw' : okResponse()))

    const result = await api.embedTexts(['要不要带伞'], 800, {
      tunnelFallbackTimeoutMs: api.RECALL_FALLBACK_TIMEOUT_MS,
    })

    expect(result.dim).toBe(2)
    expect(calls.map((call) => call.url)).toEqual([SAME_ORIGIN, EMBEDDINGS_VIA_TUNNEL])
    expect(api.RECALL_FALLBACK_TIMEOUT_MS).toBe(2500)
  })

  it('不传换路预算时只打一次主路，失败就直接抛', async () => {
    installFetch((url) => (url === SAME_ORIGIN ? 'throw' : okResponse()))

    await expect(api.embedTexts(['一句话'], 800)).rejects.toThrow()

    expect(calls.map((call) => call.url)).toEqual([SAME_ORIGIN])
  })
})
