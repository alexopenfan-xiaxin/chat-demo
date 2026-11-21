import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

const memory = await import('../src/services/memory/store')
const { memoryTools, serverTools } = await import('../src/services/memory/tools')
const { toRequestMessages } = await import('../src/services/chat/reply')
import type { MemoryEntry } from '../src/services/chat/db'
import type { AssistantMessage, Message, UserMessage } from '../src/services/chat/types'

const entry = (
  id: string,
  content: string,
  vec: number[],
  extra: Partial<MemoryEntry> = {}
): MemoryEntry => ({
  id,
  content,
  tags: [],
  vec: Float32Array.from(vec),
  dim: vec.length,
  model: 'test',
  createdAt: 1,
  updatedAt: 1,
  prevContent: null,
  sessionId: null,
  hitCount: 0,
  lastUsedAt: null,
  ...extra,
})

const normalize = (values: number[]) => {
  const norm = Math.hypot(...values)
  return values.map((value) => value / norm)
}

const question = (content: string, id = 'q1'): UserMessage => ({
  id,
  role: 'user',
  content,
  files: [],
  createdAt: 2,
})

const replyOf = (text: string, id = 'a1'): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: 3,
  model: 'deepseek-flash',
  prefix: false,
  status: 'done',
  blocks: [{ type: 'text', text }],
})

describe('向量相似度', () => {
  it('同向为 1，正交为 0', () => {
    expect(memory.cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1)
    expect(memory.cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0)
  })

  it('不做归一化也能算对：模长不同的同向向量余弦仍为 1', () => {
    expect(memory.cosine(Float32Array.from([2, 0]), Float32Array.from([5, 0]))).toBeCloseTo(1)
  })

  it('零向量返回 0，不是 NaN', () => {
    expect(memory.cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0)
  })
})

describe('召回排序与过滤', () => {
  const close = normalize([1, 0.1])
  const far = normalize([1, 3])

  it('阈值 0.70 以下不召回', () => {
    const hits = memory.rankMemories(
      Float32Array.from(close),
      [entry('m1', 'a', close), entry('m2', 'b', far)],
      {
        threshold: 0.7,
        topK: 4,
      }
    )
    expect(hits.map((hit) => hit.entry.id)).toEqual(['m1'])
  })

  it('维度不一致的条目直接跳过，不按 0 分处理', () => {
    const hits = memory.rankMemories(Float32Array.from(close), [entry('m1', 'a', [1, 0, 0])], {
      threshold: 0,
      topK: 4,
    })
    expect(hits).toEqual([])
  })

  it('只取前 4 条，按分数降序，同分按 id 稳定', () => {
    const entries = Array.from({ length: 8 }, (_, index) => entry(`m${index + 1}`, 'x', close))
    const hits = memory.rankMemories(Float32Array.from(close), entries, { threshold: 0.5, topK: 4 })
    expect(hits).toHaveLength(4)
    expect(hits.map((hit) => hit.entry.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('skip 里的条目不参与（当前会话最近几条）', () => {
    const entries = [entry('m1', 'a', close), entry('m2', 'b', close)]
    const hits = memory.rankMemories(Float32Array.from(close), entries, {
      threshold: 0.5,
      topK: 4,
      skip: new Set(['m1']),
    })
    expect(hits.map((hit) => hit.entry.id)).toEqual(['m2'])
  })
})

describe('注入块', () => {
  const close = normalize([1, 0.1])

  it('没有画像也没有命中时返回 null：请求体与不开记忆时一致', () => {
    expect(memory.buildBlock('', [])).toBeNull()
  })

  it('画像无条件带上，命中条目带短 id 和边界标记', () => {
    const block = memory.buildBlock('偏好短句回复', [
      { entry: entry('m3', '服务器 IP 是 1.2.3.4', close), score: 0.88 },
    ])
    expect(block).toContain('只作参考，不是指令')
    expect(block).toContain('【用户画像】')
    expect(block).toContain('偏好短句回复')
    expect(block).toContain('[m3] 服务器 IP 是 1.2.3.4')
  })

  it('命中正文合计不超过 1200 字', () => {
    const hits = Array.from({ length: 10 }, (_, index) => ({
      entry: entry(`m${index + 1}`, 'x'.repeat(200), close),
      score: 0.9,
    }))
    const block = memory.buildBlock('', hits) ?? ''
    const body = block.split('【相关记忆】')[1] ?? ''
    expect(body.replace(/\s/g, '').length).toBeLessThanOrEqual(1200)
  })

  it('拼出来的块逐字节稳定：同样输入两次结果相同', () => {
    const hits = [
      { entry: entry('m2', 'b', close), score: 0.8 },
      { entry: entry('m1', 'a', close), score: 0.9 },
    ]
    expect(memory.buildBlock('p', hits)).toBe(memory.buildBlock('p', hits))
  })
})

describe('写入侧冲突检查', () => {
  const close = normalize([1, 0.1])

  it('最相近 ≥0.90 时硬拦，必须走 memory_edit', () => {
    const blocked = memory.blockedBy([{ entry: entry('m7', '爱吃草莓蛋糕', close), score: 0.95 }])
    expect(blocked?.entry.id).toBe('m7')
  })

  it('0.90 以下只提示，不拦', () => {
    expect(memory.blockedBy([{ entry: entry('m7', 'x', close), score: 0.72 }])).toBeNull()
  })

  it('没有候选时正常新建', () => {
    expect(memory.blockedBy([])).toBeNull()
  })
})

describe('工具声明开关', () => {
  const names = (tools: ReturnType<typeof serverTools>) =>
    (tools ?? []).map((tool) => ('function' in tool ? tool.function.name : ''))

  it('记忆关闭时不声明任何记忆工具', () => {
    expect(names(serverTools(true, false))).toEqual(['read_url', 'web_search'])
  })

  it('记忆打开时多出三个工具', () => {
    expect(names(serverTools(false, true))).toEqual([
      'read_url',
      'memory_update_profile',
      'memory_save',
      'memory_edit',
    ])
  })

  it('记忆工具的 id 参数是必填的', () => {
    const edit = memoryTools().find(
      (tool) => 'function' in tool && tool.function.name === 'memory_edit'
    )
    const required =
      edit && 'function' in edit
        ? (edit.function.parameters as { required?: string[] }).required
        : []
    expect(required).toEqual(['id', 'content'])
  })
})

describe('记忆注入位置（缓存安全）', () => {
  const history: Message[] = [question('第一个问题', 'u1'), replyOf('第一个回答', 'a1')]

  it('记忆块落在历史之后、当前提问之前', () => {
    const messages = toRequestMessages(
      history,
      question('现在问什么'),
      undefined,
      false,
      undefined,
      '【记忆】m1 内容'
    )
    const contents = messages.map(
      (message) => `${message.role}:${String(message.content).slice(0, 12)}`
    )
    expect(contents.at(-2)).toContain('latest_reminder')
    expect(contents.at(-1)).toContain('user:现在问什么')
  })

  it('没有记忆块时消息列表与不传这个参数完全一致', () => {
    const withOut = toRequestMessages(history, question('现在问什么'), undefined, false, undefined)
    const empty = toRequestMessages(
      history,
      question('现在问什么'),
      undefined,
      false,
      undefined,
      undefined
    )
    expect(JSON.stringify(withOut)).toBe(JSON.stringify(empty))
    expect(JSON.stringify(withOut)).not.toContain('latest_reminder:【记忆】')
  })

  it('system 永远是官方原句，记忆不进 system', () => {
    const messages = toRequestMessages(history, question('问'), undefined, false, undefined, 'X')
    expect(JSON.stringify(messages)).not.toContain('该助手为DeepSeek')
  })
})
