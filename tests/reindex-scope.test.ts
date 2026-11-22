import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

/** 让向量计算「慢一拍」，好在它还没回来的时候切号 */
const embed = vi.hoisted(() => ({ calls: 0, delay: 5 }))

vi.mock('../src/services/memory/localEmbed', () => ({
  embedLocal: async (texts: string[]) => {
    embed.calls += 1
    await new Promise((resolve) => setTimeout(resolve, embed.delay))
    return { vectors: texts.map(() => [1, 0]), dim: 2 }
  },
}))

vi.mock('../src/services/memory/localModel', async (original) => {
  const actual = await original<typeof import('../src/services/memory/localModel')>()
  return { ...actual, hasLocalModel: async () => true }
})

const db = await import('../src/services/chat/db')
const api = await import('../src/services/memory/api')
const reindex = await import('../src/services/memory/reindex')

const user = (seed: string) => {
  const hex = (length: number) => (seed + '0'.repeat(length)).slice(0, length).toLowerCase()
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`
}
const A = user('a1')
const B = user('b2')

const entry = {
  id: 'm1',
  content: 'A 写的记忆',
  tags: [],
  vec: new Float32Array([1, 0]),
  dim: 2,
  // 旧模型标记：reindex 会把它当成待重算的条目
  model: 'legacy-model',
  createdAt: 1,
  updatedAt: 1,
  prevContent: null,
  sessionId: null,
  hitCount: 0,
  lastUsedAt: null,
}

describe('切号后记忆重算不再继续', () => {
  beforeEach(async () => {
    embed.calls = 0
    embed.delay = 5
    await db.setStorageScope(null)
  })

  it('reindex 在切号后停止，不把 A 的条目重算成 B 的向量', async () => {
    await db.setStorageScope(A)
    await db.putMemory(entry)

    const running = reindex.startReindex()
    // 等探针那一次 embedTexts 起飞，再切号
    await new Promise((resolve) => setTimeout(resolve, 1))
    await db.setStorageScope(B)
    await running
    // 切号之后 embedTexts 的调用次数不再增长（不管传输层是本地还是远端）
    const afterSwitch = embed.calls
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(embed.calls).toBe(afterSwitch)

    await db.setStorageScope(A)
    const stored = await db.loadMemory('m1')
    expect(stored?.model).toBe('legacy-model')
    expect(stored?.content).toBe('A 写的记忆')
  })

  it('embedTexts 在切号瞬间作废，不会用新账号的票继续算', async () => {
    await db.setStorageScope(A)
    const pending = api.embedTexts(['正文'], 5_000)
    await db.setStorageScope(B)
    await expect(pending).rejects.toThrow(/scope/i)
  })
})
