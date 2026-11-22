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
const { applyAccountScope } = await import('../src/services/account-scope')

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
    // 走生产入口：除了清空作用域，也把上一轮遗留的登记项一并中止，
    // 免得某条用例忘了 await 时把它的 controller 带进下一轮
    await applyAccountScope(null)
  })

  it('切号后这一轮重算立刻停手，embed 调用次数不再增长', async () => {
    await db.setStorageScope(A)
    // 20 条旧模型条目 = 探针 1 次 + 三批（8/8/4），批间隔 200ms，够切号插进来
    const stale = Array.from({ length: 20 }, (_, index) => ({
      ...entry,
      id: `m${index}`,
      content: `A 的记忆 ${index}`,
    }))
    for (const item of stale) {
      await db.putMemory(item)
    }

    const running = reindex.startReindex()
    // 等探针 + 第一批都起飞（调用数到 2），这时切号
    const deadline = Date.now() + 1_000
    while (embed.calls < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(embed.calls).toBe(2)

    await applyAccountScope(B)
    const callsAtSwitch = embed.calls
    await running
    // 原本第二批会在 200ms 后起飞，再等一轮确认它没有起飞
    await new Promise((resolve) => setTimeout(resolve, reindex.REINDEX_INTERVAL_MS * 2))

    expect(embed.calls).toBe(callsAtSwitch)
  })

  it('embedTexts 在切号瞬间作废，不会用新账号的票继续算', async () => {
    await db.setStorageScope(A)
    const pending = api.embedTexts(['正文'], 5_000)
    await db.setStorageScope(B)
    await expect(pending).rejects.toThrow(/scope/i)
  })
})
