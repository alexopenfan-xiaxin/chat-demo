import { describe, expect, it, vi } from 'vitest'

// view/parse 会连带引入 api 客户端层，那里读构建期注入的常量
vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

const { buildReplyView } = await import('../src/services/chat/view')
const { toMdAst } = await import('../src/services/markdown/parse')
type AssistantMessage = import('../src/services/chat/types').AssistantMessage

/** 一条带搜索结果块和正文引用的回复；结果里混进一个 javascript: 链接 */
const reply = (): AssistantMessage => ({
  id: 'm1',
  role: 'assistant',
  createdAt: 0,
  model: 'deepseek-flash',
  prefix: false,
  status: 'done',
  blocks: [
    {
      type: 'server_tool_use',
      id: 'srvtoolu_s_1_abc',
      name: 'deepseek_web_search',
      input: { queries: ['测试'] },
      caller: { type: 'direct' },
      kind: 'search',
    },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_s_1_abc',
      content: [
        {
          type: 'web_search_result',
          title: '正常来源',
          url: 'https://example.com/a',
          snippet: '',
          site_icon: null,
          site_name: 'example.com',
          page_age: null,
        },
        {
          type: 'web_search_result',
          title: '恶意来源',
          url: 'javascript:alert(1)',
          snippet: '',
          site_icon: null,
          site_name: null,
          page_age: null,
        },
      ],
    },
  ],
})

describe('回复里的链接只接受 http/https', () => {
  it('javascript: 的结果进不了来源列表', () => {
    const view = buildReplyView(reply(), false)
    expect(view.sources.map((source) => source.url)).toEqual(['https://example.com/a'])
    expect(view.sources.some((source) => source.url.startsWith('javascript:'))).toBe(false)
  })

  it('指向它的 [citation] 角标不产生节点，正文里也就没有可点的角标', () => {
    const view = buildReplyView(reply(), false)
    const ast = toMdAst('正常[citation:1]，恶意[citation:2]。', {
      sources: view.sources,
      disableLink: false,
    })
    const citations: string[] = []
    const walk = (node: unknown) => {
      const value = node as { type?: string; source?: { url: string }; children?: unknown[] }
      if (value.type === 'citation' && value.source) {
        citations.push(value.source.url)
      }
      value.children?.forEach(walk)
    }
    walk(ast)
    expect(citations).toEqual(['https://example.com/a'])
  })
})
