import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

const state = vi.hoisted(() => ({
  memoryOn: true,
  used: 0,
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
vi.mock('../src/services/settings', () => ({
  useSettings: { getState: () => ({ memory: state.memoryOn }) },
}))
vi.mock('../src/services/auth', () => ({
  ensureAccessToken: async () => 'test-token',
}))

const { useMemoryStatus } = await import('../src/services/memory/api')
const prefetch = await import('../src/services/memory/prefetch')
const memory = await import('../src/services/memory/store')

/** 每次请求都回同一个「偏好短句」方向的向量 */
const answer = () =>
  new Response(JSON.stringify({ vectors: [[1, 0]], dim: 2, model: 'test' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const fetchMock = vi.fn(async () => answer())

beforeEach(() => {
  vi.useFakeTimers()
  state.memoryOn = true
  state.used = 0
  fetchMock.mockClear()
  fetchMock.mockImplementation(async () => answer())
  vi.stubGlobal('fetch', fetchMock)
  useMemoryStatus.setState({ available: true })
  prefetch.resetPrefetch()
})

describe('输入预取', () => {
  it('停顿 400ms 才发一次，提前敲下一个字就不发', async () => {
    prefetch.prefetchInput('用户偏好')
    await vi.advanceTimersByTimeAsync(399)
    expect(fetchMock).not.toHaveBeenCalled()

    prefetch.prefetchInput('用户偏好短')
    await vi.advanceTimersByTimeAsync(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('算完就进缓存，同一句再停顿不再发请求', async () => {
    prefetch.prefetchInput('用户偏好短句回复')
    await vi.advanceTimersByTimeAsync(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(prefetch.takeVector('用户偏好短句回复')).not.toBeNull()

    prefetch.prefetchInput('用户偏好短句回复')
    await vi.advanceTimersByTimeAsync(800)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('两次预取之间不足 1200ms 时推迟，而不是丢弃', async () => {
    prefetch.prefetchInput('第一句话')
    await vi.advanceTimersByTimeAsync(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    prefetch.prefetchInput('第二句话')
    await vi.advanceTimersByTimeAsync(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 等过最小间隔，第二句补上
    await vi.advanceTimersByTimeAsync(900)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(prefetch.takeVector('第二句话')).not.toBeNull()
  })

  it('记忆开关关掉时不发任何请求', async () => {
    state.memoryOn = false
    prefetch.prefetchInput('用户偏好短句回复')
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('服务端不可用时不再尝试', async () => {
    useMemoryStatus.setState({ available: false })
    prefetch.prefetchInput('用户偏好短句回复')
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('一两个字不预取', async () => {
    prefetch.prefetchInput('好')
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('请求失败静默，不留缓存也不抛', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('network')
    })
    prefetch.prefetchInput('用户偏好短句回复')
    await vi.advanceTimersByTimeAsync(500)
    expect(prefetch.takeVector('用户偏好短句回复')).toBeNull()
  })
})

describe('检索走缓存', () => {
  it('命中预取时零网络，直接按本地向量召回', async () => {
    prefetch.prefetchInput('用户偏好短句回复')
    await vi.advanceTimersByTimeAsync(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const hits = await memory.searchMemory('用户偏好短句回复')
    // 上面那次是预取，检索本身没有再发请求
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hits?.map((hit) => hit.entry.id)).toEqual(['m1'])
  })

  it('没命中缓存时用兜底向量，同样不发请求', async () => {
    prefetch.setLastQuery(Float32Array.from([1, 0]), 2)
    const hits = await memory.searchMemory('今天天气怎么样')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(hits?.map((hit) => hit.entry.id)).toEqual(['m1'])
  })

  it('检索预览不许用兜底：没缓存就现算', async () => {
    prefetch.setLastQuery(Float32Array.from([0, 1]), 2)
    await memory.searchMemory('今天天气怎么样', null, { fallback: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('兜底向量与这句话无关时，阈值把它挡在外面', async () => {
    prefetch.setLastQuery(Float32Array.from([0, 1]), 2)
    const hits = await memory.searchMemory('今天天气怎么样')
    expect(hits).toEqual([])
  })

  it('现算成功后会写进缓存，下次同样的话不再请求', async () => {
    await memory.searchMemory('用户偏好短句回复', null, { fallback: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(prefetch.takeVector('用户偏好短句回复')).not.toBeNull()

    await memory.searchMemory('用户偏好短句回复')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
