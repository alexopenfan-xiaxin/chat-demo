import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { openDB } from 'idb'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

const db = await import('../src/services/chat/db')
const { applyAccountScope } = await import('../src/services/account-scope')

/** 真实形状的 user.id（UUID）；每个用例用独立的一对，免得共用同一个库互相影响 */
const user = (seed: string) => {
  const hex = (length: number) => (seed + '0'.repeat(length)).slice(0, length).toLowerCase()
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`
}
const A = user('a1')
const B = user('b2')

const session = (id: string) => ({
  id,
  title: 'A 的会话',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  compaction: null,
})

describe('库名', () => {
  it('用 UUID 原样拼接，不改写', () => {
    expect(db.dbNameFor(A)).toBe(`chat-demo:u:${A}`)
    expect(db.dbNameFor(A.toUpperCase())).toBe(`chat-demo:u:${A}`)
  })

  it('邮箱、空串、超长 id 一律拒绝', () => {
    expect(() => db.dbNameFor('a@b.com')).toThrow()
    expect(() => db.dbNameFor('')).toThrow()
    expect(() => db.dbNameFor('f'.repeat(37))).toThrow()
  })
})

describe('账号隔离', () => {
  beforeEach(async () => {
    await applyAccountScope(null)
  })

  it('未登录时拒绝一切读写，也不建库', async () => {
    await expect(db.loadSessionSummaries()).rejects.toThrow()
    await expect(db.loadMemories()).rejects.toThrow()
  })

  it('A 的聊天与画像对 B 不可见，且 A 的库原样还在', async () => {
    const A = user('c3')
    const B = user('d4')
    await applyAccountScope(A)
    await db.saveSession(session('s-a'))
    await db.putMemory({
      id: 'm1',
      content: 'A 的记忆',
      tags: [],
      vec: new Float32Array(2),
      dim: 2,
      model: 'test',
      createdAt: 1,
      updatedAt: 1,
      prevContent: null,
      sessionId: null,
      hitCount: 0,
      lastUsedAt: null,
    })
    await db.saveMemoryProfile({ id: 'profile', text: 'A 的画像', updatedAt: 1 })
    expect(await db.loadSessionSummaries()).toHaveLength(1)

    await applyAccountScope(B)
    expect(await db.loadSessionSummaries()).toEqual([])
    expect(await db.loadMemories()).toEqual([])
    expect(await db.loadMemoryProfile()).toBeUndefined()

    // 换回 A：数据还在（老库没被动过）
    await applyAccountScope(A)
    expect(await db.loadSessionSummaries()).toHaveLength(1)
    expect(await db.loadMemories()).toHaveLength(1)
  })

  it('切号瞬间发起的写被拒绝，不写进任何一边', async () => {
    const A = user('e5')
    const B = user('f6')
    await applyAccountScope(A)
    const pending = db.saveSession(session('s-race'))
    await applyAccountScope(B)
    await expect(pending).rejects.toThrow(/storage_scope_changed|scope/i)

    await applyAccountScope(A)
    expect(await db.loadSessionSummaries()).toEqual([])
  })

  it('切号会中止已登记的摘要、重算等后台请求', async () => {
    const { trackRequest, untrackRequest } = await import('../src/services/account-abort')
    await applyAccountScope(user('77'))
    const summary = trackRequest(new AbortController())
    expect(summary.signal.aborted).toBe(false)

    await applyAccountScope(user('88'))
    // 摘要请求最长 180 秒、记忆重算逐批跑，它们不在 streaming 表里，只能靠登记表统一掐断
    expect(summary.signal.aborted).toBe(true)
    untrackRequest(summary)
  })

  it('老库 chat-demo 不在分区范围内，切换不会碰它', async () => {
    const A = user('11')
    const B = user('22')
    const legacy = await openDB('chat-demo', 1, {
      upgrade(handle) {
        handle.createObjectStore('sessions', { keyPath: 'id' })
      },
    })
    await legacy.put('sessions', { id: 'legacy-1' })
    legacy.close()

    await applyAccountScope(A)
    await db.saveSession(session('s-a'))
    await applyAccountScope(B)

    const reopened = await openDB('chat-demo', 1)
    expect(await reopened.get('sessions', 'legacy-1')).toEqual({ id: 'legacy-1' })
    reopened.close()
  })
})
