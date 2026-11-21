import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

/**
 * 换模型后的隔离与重算：
 *
 * qwen 是 768 维、bge-m3 是 1024 维，两个向量空间不通用，跨模型算出来的余弦没有意义。
 * 所以条目里存 `model`，召回只跟同模型的条目比；旧模型条目在重算完成前静默跳过，
 * 由 reindex 分批补算回来。这两条是换模型能不能安全上线的前提，必须有用例盯着。
 */
const OLD_MODEL = 'xop3qwen8bembedding'
const NEW_MODEL = '@cf/baai/bge-m3'

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

/** 假向量：所有文本都映射到同一个方向，保证「同模型的条目」一定过阈值 */
const vectorOf = (dim: number) => Array.from({ length: dim }, (_value, index) => (index === 0 ? 1 : 0))

// 重算任务现在先看本地模型在不在；node 里没有 Cache Storage，直接放行
vi.mock('../src/services/memory/localModel', () => ({
  hasLocalModel: async () => true,
  LOCAL_MODEL_LABEL: 'local-bge-small-zh-v1.5',
}))

vi.mock('../src/services/memory/api', async () => {
  const actual = await vi.importActual<typeof import('../src/services/memory/api')>('../src/services/memory/api')
  return {
    ...actual,
    // 开关已经切到 bge-m3，重算任务才会开张
    EMBEDDINGS_MODEL: 'cf-bge-m3',
    embedTexts: async (texts: string[]) => ({
      vectors: texts.map(() => vectorOf(1024)),
      dim: 1024,
      model: NEW_MODEL,
    }),
    embedTextsAs: async (_model: string, texts: string[]) => ({
      vectors: texts.map(() => vectorOf(1024)),
      dim: 1024,
      model: NEW_MODEL,
    }),
    EmbeddingsUnavailable: class EmbeddingsUnavailable extends Error {},
  }
})

const memory = await import('../src/services/memory/store')
const { startReindex, useReindex } = await import('../src/services/memory/reindex')

const put = (id: string, content: string, model: string, dim: number) => {
  rows.set(id, {
    id,
    content,
    tags: [],
    vec: Float32Array.from(vectorOf(dim)),
    dim,
    model,
    createdAt: 1,
    updatedAt: 1,
    prevContent: null,
    sessionId: null,
    hitCount: 0,
    lastUsedAt: null,
  })
}

beforeEach(() => {
  rows.clear()
  useReindex.setState({ running: false, done: 0, total: 0, model: '' })
})

describe('跨模型的条目', () => {
  it('旧模型的条目不参与召回，即使维度碰巧一样也跳过', async () => {
    // 故意把维度对齐成 1024：说明拦住它的是 model 而不是 dim
    put('m1', '最爱吃芒果布丁', OLD_MODEL, 1024)

    const hits = await memory.searchMemory('我爱吃什么甜点', null)

    expect(hits).toEqual([])
  })

  it('同模型的条目照常召回', async () => {
    put('m1', '最爱吃芒果布丁', NEW_MODEL, 1024)

    const hits = await memory.searchMemory('我爱吃什么甜点', null)

    expect(hits).toHaveLength(1)
    expect(hits?.[0].entry.id).toBe('m1')
  })

  it('model 为空的更早条目按维度放行，不会凭空消失', async () => {
    put('m1', '换模型前写下的记忆', '', 1024)

    const hits = await memory.searchMemory('我爱吃什么甜点', null)

    expect(hits).toHaveLength(1)
  })

  it('重算之后同一条记忆又能被召回', async () => {
    put('m1', '最爱吃芒果布丁', OLD_MODEL, 768)

    // 重算前：旧模型 → 召回为空
    expect(await memory.searchMemory('我爱吃什么甜点', null)).toEqual([])

    await startReindex()

    // 条目已经换到新模型和新维度
    const upgraded = rows.get('m1') as { model: string; dim: number } | undefined
    expect(upgraded?.model).toBe(NEW_MODEL)
    expect(upgraded?.dim).toBe(1024)

    // 重算后：同一条能被召回
    const hits = await memory.searchMemory('我爱吃什么甜点', null)
    expect(hits).toHaveLength(1)
    expect(hits?.[0].entry.id).toBe('m1')
  })

  it('重算按批推进，并记下进度', async () => {
    for (let index = 1; index <= 3; index += 1) {
      put(`m${index}`, `第 ${index} 条旧记忆`, OLD_MODEL, 768)
    }

    await startReindex()

    expect(useReindex.getState().done).toBe(3)
    expect(useReindex.getState().total).toBe(3)
    expect(useReindex.getState().running).toBe(false)
    expect([...rows.values()].every((entry) => (entry as { model: string }).model === NEW_MODEL)).toBe(true)
  })
})
