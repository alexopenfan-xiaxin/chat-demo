import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

const state = vi.hoisted(() => ({
  entries: [
    {
      id: 'm2',
      content: '用户要求：思考过程必须使用中文书写。',
      tags: ['偏好'],
      // 用 4 维代替真实的 512 维，只验导出形状
      vec: new Float32Array([0.5, -0.25, 0, 0.125]),
      dim: 4,
      model: 'local-bge-small-zh-v1.5',
      createdAt: 1795178362094,
      updatedAt: 1795178362094,
      prevContent: null,
      sessionId: 'b44a25b1',
      hitCount: 4,
      lastUsedAt: 1795244380704,
    },
  ],
  profile: '用户自称 Alex。',
}))

vi.mock('../src/services/chat/db', () => ({
  loadMemories: async () => state.entries,
  loadMemoryProfile: async () => ({ id: 'profile', text: state.profile, updatedAt: 1 }),
}))

const { exportMemories } = await import('../src/services/memory/store')

describe('exportMemories', () => {
  it('带上 vec、dim、model，vec 是纯数字数组且与库里一致', async () => {
    const parsed = JSON.parse(await exportMemories()) as {
      profile: string
      memories: {
        id: string
        vec: number[]
        dim: number
        model: string
        content: string
        hitCount: number
      }[]
    }

    expect(parsed.profile).toBe(state.profile)
    expect(parsed.memories).toHaveLength(1)

    const [entry] = parsed.memories
    // Float32Array 直接 JSON.stringify 会变成 {"0":..,"1":..}，这里必须是数组
    expect(Array.isArray(entry.vec)).toBe(true)
    expect(entry.vec).toEqual([0.5, -0.25, 0, 0.125])
    expect(entry.dim).toBe(4)
    expect(entry.model).toBe('local-bge-small-zh-v1.5')
    // 其余字段原样带出，不因导出而丢
    expect(entry.id).toBe('m2')
    expect(entry.content).toBe(state.entries[0].content)
    expect(entry.hitCount).toBe(4)
  })
})
