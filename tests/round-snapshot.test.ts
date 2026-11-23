import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

/**
 * 一轮回复里工具可能往返好几次，每次都是一个独立的子请求。
 * 子请求的尾巴（提醒快照、记忆块）只要差一个字节，前缀缓存就从那里断开——
 * 所以这两样必须在一轮开始时算一次，整轮复用。
 */
const seen = vi.hoisted(() => ({
  reminders: 0,
  searches: 0,
  profiles: 0,
  bodies: [] as Array<Record<string, unknown>>,
  toolRounds: 0,
}))

vi.mock('../src/services/chat/latestReminder', () => ({
  createLatestReminder: () => {
    seen.reminders += 1
    return '2026-11-23,星期一,北京,Web,中文'
  },
}))

vi.mock('../src/services/memory/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/memory/store')>()
  return {
    ...actual,
    loadProfile: async () => {
      seen.profiles += 1
      return '用户在做 ds-chat'
    },
    searchMemory: async () => {
      seen.searches += 1
      return [
        {
          entry: {
            id: 'm1',
            content: '偏好短句',
            tags: [],
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
          score: 0.91,
        },
      ]
    },
    markHits: async () => {},
  }
})

vi.mock('../src/services/api/client', () => ({
  ApiError: class ApiError extends Error {},
  streamMessage: async function* (
    _key: string,
    body: Record<string, unknown>
  ): AsyncGenerator<Record<string, unknown>> {
    seen.bodies.push(body)
    if (seen.toolRounds === 0) {
      seen.toolRounds = 1
      yield {
        type: 'tool_call',
        call: { callId: 'call-1', name: 'web_search', arguments: '{"query":"今天的高铁"}' },
      }
      return
    }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好的' } }
    yield { type: 'content_block_stop', index: 0 }
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 100, output_tokens: 2 },
    }
    yield { type: 'message_stop' }
  },
}))

vi.mock('../src/services/chat/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/chat/db')>()
  return {
    ...actual,
    saveSession: async () => {},
    loadFile: async () => undefined,
  }
})

const { streamReply, useChatStore } = await import('../src/services/chat/store')
const { useSettings } = await import('../src/services/settings')

const SESSION = {
  id: 's1',
  title: '高铁',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  compaction: null,
}

const initial = {
  id: 'a1',
  role: 'assistant' as const,
  createdAt: 2,
  model: 'deepseek-flash' as const,
  thinking: false,
  search: true,
  prefix: false,
  status: 'streaming' as const,
  blocks: [],
}

const question = {
  id: 'u1',
  role: 'user' as const,
  content: '搜一下今天的高铁再回答',
  files: [],
  createdAt: 2,
}

beforeEach(() => {
  seen.reminders = 0
  seen.searches = 0
  seen.profiles = 0
  seen.bodies = []
  seen.toolRounds = 0
  vi.stubGlobal('document', { visibilityState: 'visible' })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }))
  )
  // 记忆开关打开，才会检索并注入记忆块
  useSettings.setState({ memory: true, search: true })
  useChatStore.setState({
    ready: true,
    activeId: 's1',
    sessions: [{ id: 's1', title: '高铁', createdAt: 1, updatedAt: 1 }],
    sessionCache: { s1: SESSION },
  })
})

describe('一轮内的工具往返复用同一份快照', () => {
  it('两次子请求的提醒与记忆块逐字节一致，且各只生成一次', async () => {
    await streamReply('s1', initial as never, { history: [], question } as never)

    // 一次搜索 + 一次收尾 = 两个子请求
    expect(seen.bodies).toHaveLength(2)
    // 提醒与记忆检索都只发生在轮首
    expect(seen.reminders).toBe(1)
    expect(seen.searches).toBe(1)
    expect(seen.profiles).toBe(1)

    const [first, second] = seen.bodies as Array<{ messages: unknown[] }>
    // 尾巴一致：这正是前缀缓存能接上的前提
    expect(JSON.stringify(first.messages)).toBe(JSON.stringify(second.messages))
    expect(JSON.stringify(first)).toContain('2026-11-23,星期一,北京,Web,中文')
    expect(JSON.stringify(first)).toContain('偏好短句')
  })
})
