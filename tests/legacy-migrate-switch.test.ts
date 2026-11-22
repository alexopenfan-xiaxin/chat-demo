import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { deleteDB, openDB } from 'idb'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

const installStorage = () => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  })
  return store
}

/** 门控：整包写入前后各留一个挂点，好在「正要写」时切号、或让它失败一次 */
const gate = vi.hoisted(() => ({
  calls: 0,
  failOnce: false,
  before: null as null | (() => Promise<void>),
}))

vi.mock('../src/services/chat/db', async (original) => {
  const actual = await original<typeof import('../src/services/chat/db')>()
  return {
    ...actual,
    saveLegacyBundle: async (...args: Parameters<typeof actual.saveLegacyBundle>) => {
      gate.calls += 1
      if (gate.failOnce) {
        gate.failOnce = false
        throw new Error('simulated local write failure')
      }
      if (gate.before) {
        await gate.before()
      }
      return actual.saveLegacyBundle(...args)
    },
  }
})

const db = await import('../src/services/chat/db')
const { migrateLegacyOnce, LEGACY_MIGRATED_FLAG } = await import('../src/services/legacy-migrate')
const { applyAccountScope } = await import('../src/services/account-scope')

const A = '11111111-2222-3333-4444-555555555555'
const B = '99999999-8888-7777-6666-555555555555'

const session = (id: string) => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  messages: [
    { id: `${id}-m1`, role: 'user' as const, content: '你好', files: [], createdAt: 1 },
    { id: `${id}-m2`, role: 'assistant' as const, content: '在', createdAt: 2 },
  ],
  compaction: null,
})

const seedLegacy = async () => {
  const handle = await openDB('chat-demo', 1, {
    upgrade(upgradeDb) {
      upgradeDb.createObjectStore('sessions', { keyPath: 'id' })
      upgradeDb.createObjectStore('memories', { keyPath: 'id' })
      upgradeDb.createObjectStore('memoryProfile', { keyPath: 'id' })
      upgradeDb.createObjectStore('files', { keyPath: 'id' })
    },
  })
  for (const id of ['s1', 's2', 's3']) {
    await handle.put('sessions', session(id))
  }
  handle.close()
}

const countIn = async (userId: string) => {
  await applyAccountScope(userId)
  return (await db.loadSessionSummaries()).length
}

beforeEach(async () => {
  installStorage()
  gate.calls = 0
  gate.failOnce = false
  gate.before = null
  await db.setStorageScope(null)
  await deleteDB('chat-demo')
  await deleteDB(db.dbNameFor(A))
  await deleteDB(db.dbNameFor(B))
})

describe('迁移钉在起始账号上', () => {
  it('正要写时切到 B：一条都不写，返回 aborted，也不写标记', async () => {
    await seedLegacy()
    await applyAccountScope(A)

    let release = () => {}
    gate.before = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })

    const running = migrateLegacyOnce(A)
    const deadline = Date.now() + 2_000
    while (gate.calls === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(gate.calls).toBe(1)

    // 写入还没发生，这时用户切到 B
    await applyAccountScope(B)
    release()
    const result = await running

    expect(result).toEqual({ status: 'aborted' })
    // B 一条都不该拿到：旧数据是 A 的
    expect(await db.loadSessionSummaries()).toHaveLength(0)
    await applyAccountScope(A)
    expect(await db.loadSessionSummaries()).toHaveLength(0)
    expect(localStorage.getItem(LEGACY_MIGRATED_FLAG)).toBeNull()
  })

  it('切号发生在迁移入口之前就不启动', async () => {
    await seedLegacy()
    await applyAccountScope(B)
    // 拿 A 的 id 来迁，但当前作用域是 B：入口直接拒绝，连旧库都不打开
    expect(await migrateLegacyOnce(A)).toEqual({ status: 'aborted' })
    expect(await db.loadSessionSummaries()).toHaveLength(0)
  })
})

describe('原子写入：失败不留下半截库，重试能补齐', () => {
  it('第一次写入整体失败，第二次把三条都写进去', async () => {
    await seedLegacy()
    await applyAccountScope(A)

    gate.failOnce = true
    const first = await migrateLegacyOnce(A)
    expect(first).toMatchObject({ status: 'failed' })
    // 失败即回滚：目标库仍然是空的，「为空才迁」这条判据在重试时依然成立
    expect(await db.loadSessionSummaries()).toHaveLength(0)

    const second = await migrateLegacyOnce(A)
    expect(second).toEqual({ status: 'done', stats: { sessions: 3, memories: 0 } })
    expect(await db.loadSessionSummaries()).toHaveLength(3)
    expect(localStorage.getItem(LEGACY_MIGRATED_FLAG)).toBeTruthy()
  })
})
