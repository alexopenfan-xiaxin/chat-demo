import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

/**
 * editMemory 的两种定位方式：
 * 1. 直接给编号——不再要求「本轮注入过」，任何已存记忆都能改；
 * 2. 给一句描述——算向量在全库找，top1 ≥0.90 且拉开第二名 0.05 才改，否则回候选。
 *
 * 用内存里的假库和假 embedding 覆盖这两条，不引额外依赖。
 */
const rows = new Map<string, Record<string, unknown>>()
const embeddings = new Map<string, number[]>()

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
    embedTexts: async (texts: string[]) => ({
      vectors: texts.map((text) => embeddings.get(text) ?? [1, 0]),
      dim: 2,
      model: 'test',
    }),
    EmbeddingsUnavailable: class EmbeddingsUnavailable extends Error {},
  }
})

const { editMemory } = await import('../src/services/memory/store')

const put = (id: string, content: string, vec: number[]) => {
  rows.set(id, {
    id,
    content,
    tags: [],
    vec: Float32Array.from(vec),
    dim: 2,
    model: 'test',
    createdAt: 1,
    updatedAt: 1,
    prevContent: null,
    sessionId: null,
    hitCount: 0,
    lastUsedAt: null,
  })
}

const unit = (x: number, y: number) => {
  const norm = Math.hypot(x, y)
  return [x / norm, y / norm]
}

describe('editMemory 定位', () => {
  it('本地有这条就直接改，不再要求本轮注入过', async () => {
    rows.clear()
    put('m3', '最爱吃草莓蛋糕', unit(1, 0))
    const before = (rows.get('m3') as { updatedAt: number }).updatedAt
    const result = await editMemory({ id: 'm3', content: '最爱吃芒果布丁' })
    expect(result.ok).toBe(true)
    const saved = rows.get('m3') as { content: string; prevContent: string; updatedAt: number }
    expect(saved.content).toBe('最爱吃芒果布丁')
    expect(saved.prevContent).toBe('最爱吃草莓蛋糕')
    expect(saved.updatedAt).toBeGreaterThan(before)
  })

  it('id 查不到时当描述定位：足够像且拉开第二名就改', async () => {
    rows.clear()
    put('m5', '最爱吃芒果布丁', unit(1, 0))
    put('m6', '周末常去爬山', unit(0, 1))
    embeddings.set('我最爱吃的那道甜点', unit(0.99, 0.01))
    const result = await editMemory({ id: '我最爱吃的那道甜点', content: '其实最爱吃提拉米苏' })
    expect(result.ok).toBe(true)
    expect((rows.get('m5') as { content: string }).content).toBe('其实最爱吃提拉米苏')
    expect((rows.get('m6') as { content: string }).content).toBe('周末常去爬山')
  })

  it('描述定位不准时回候选、不改任何记忆', async () => {
    rows.clear()
    put('m5', '最爱吃芒果布丁', unit(1, 0))
    put('m6', '最爱吃草莓蛋糕', unit(0.99, 0.02))
    embeddings.set('最爱吃甜点', unit(0.98, 0.01))
    const result = await editMemory({ id: '最爱吃甜点', content: '改成布丁' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('[m5]')
    expect((rows.get('m5') as { content: string }).content).toBe('最爱吃芒果布丁')
    expect((rows.get('m6') as { content: string }).content).toBe('最爱吃草莓蛋糕')
  })
})
