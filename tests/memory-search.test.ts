import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

const state = vi.hoisted(() => ({
  entries: [
    {
      id: 'm1',
      content: '用户偏好短句回复',
      tags: [] as string[],
      vec: new Float32Array([1, 0]),
      dim: 2,
      model: 'test',
      createdAt: 1,
      updatedAt: 1,
      prevContent: null,
      sessionId: null,
      hitCount: 0,
      lastUsedAt: null,
    },
  ],
}))

vi.mock('../src/services/chat/db', () => ({
  loadMemories: async () => state.entries,
}))
vi.mock('../src/services/auth', () => ({
  ensureAccessToken: async () => 'test-token',
}))

const { useMemoryStatus } = await import('../src/services/memory/api')
const memory = await import('../src/services/memory/store')

/** 每次成功都回「偏好短句」方向的向量，命中库里的 m1 */
const answer = () =>
  new Response(JSON.stringify({ vectors: [[1, 0]], dim: 2, model: 'test' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const fetchMock = vi.fn(async () => answer())

beforeEach(() => {
  fetchMock.mockClear()
  fetchMock.mockImplementation(async () => answer())
  vi.stubGlobal('fetch', fetchMock)
  useMemoryStatus.setState({ available: true })
})

describe('发送前检索', () => {
  it('点发送时算一次向量并命中', async () => {
    const hits = await memory.searchMemory('用户偏好短句回复')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hits?.map((hit) => hit.entry.id)).toEqual(['m1'])
  })

  it('库为空时直接返回空，连向量都不算', async () => {
    const saved = state.entries
    state.entries = []
    try {
      expect(await memory.searchMemory('用户偏好短句回复')).toEqual([])
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      state.entries = saved
    }
  })

  it('空字符串不发请求', async () => {
    expect(await memory.searchMemory('   ')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('从未算成功过向量时，本次失败就返回 null（只带画像）', async () => {
    // 换一份模块实例，保证 lastVector 是空的
    vi.resetModules()
    const fresh = await import('../src/services/memory/store')
    fetchMock.mockImplementation(async () => {
      throw new Error('network')
    })
    expect(await fresh.searchMemory('第一次就失败')).toBeNull()
  })

  it('本轮失败时用上一次成功算出的向量兜底', async () => {
    await memory.searchMemory('用户偏好短句回复')
    fetchMock.mockImplementation(async () => {
      throw new Error('timeout')
    })
    const hits = await memory.searchMemory('这一句算不出向量')
    expect(hits?.map((hit) => hit.entry.id)).toEqual(['m1'])
  })

  it('记忆页预览不许用旧向量：失败就返回 null', async () => {
    await memory.searchMemory('用户偏好短句回复')
    fetchMock.mockImplementation(async () => {
      throw new Error('timeout')
    })
    expect(await memory.searchMemory('预览这句话', null, { staleFallback: false })).toBeNull()
  })
})
