import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

/**
 * 两个模型的分数分布不一样，门槛不能共用一个数：
 *
 * - qwen 实测：相关 0.744 / 0.834 / 0.861，不相关 0.466 / 0.580 → 0.70
 * - bge-m3 实测：相关 0.602 / 0.670 / 0.864 / 0.868，不相关 0.362–0.602 → 0.55
 *
 * 下面的 0.60 分就是这两段的交界：按 qwen 的门槛该被拦，按 bge 的门槛该被召回。
 */
const state = vi.hoisted(() => ({ model: '@cf/baai/bge-m3' }))

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

vi.mock('../src/services/memory/api', async () => {
  const actual = await vi.importActual<typeof import('../src/services/memory/api')>('../src/services/memory/api')
  return {
    ...actual,
    EMBEDDINGS_MODEL: 'cf-bge-m3',
    embedTexts: async (texts: string[]) => ({
      vectors: texts.map(() => [1, 0]),
      dim: 2,
      model: state.model,
    }),
    embedTextsAs: async (_model: string, texts: string[]) => ({
      vectors: texts.map(() => [1, 0]),
      dim: 2,
      model: state.model,
    }),
    EmbeddingsUnavailable: class EmbeddingsUnavailable extends Error {},
  }
})

const memory = await import('../src/services/memory/store')

const put = (id: string, content: string, vec: number[], model: string) => {
  rows.set(id, {
    id,
    content,
    tags: [],
    vec: Float32Array.from(vec),
    dim: vec.length,
    model,
    createdAt: 1,
    updatedAt: 1,
    prevContent: null,
    sessionId: null,
    hitCount: 0,
    lastUsedAt: null,
  })
}

/** cosine([1,0], [0.6,0.8]) = 0.6，正好落在两个门槛之间 */
const BORDER = [0.6, 0.8]

beforeEach(() => {
  rows.clear()
  state.model = '@cf/baai/bge-m3'
})

describe('按模型选的召回门槛', () => {
  it('两个门槛分别是 0.70 与 0.55', () => {
    expect(memory.memoryThreshold('xop3qwen8bembedding')).toBe(0.7)
    expect(memory.memoryThreshold('@cf/baai/bge-m3')).toBe(0.55)
  })

  it('bge-m3 下 0.60 分的条目会被召回', async () => {
    put('m1', '我最喜欢喝冰美式', BORDER, '@cf/baai/bge-m3')

    const hits = await memory.searchMemory('我爱喝什么咖啡', null)

    expect(hits).toHaveLength(1)
    expect(hits?.[0].score).toBeCloseTo(0.6, 5)
  })

  it('qwen 下同样的 0.60 分不会召回（门槛 0.70 拦住）', async () => {
    state.model = 'xop3qwen8bembedding'
    put('m1', '我最喜欢喝冰美式', BORDER, 'xop3qwen8bembedding')

    const hits = await memory.searchMemory('我爱喝什么咖啡', null)

    expect(hits).toEqual([])
  })
})
