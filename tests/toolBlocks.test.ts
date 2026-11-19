import { describe, expect, it } from 'vitest'
import { fetchBlocks, searchBlocks } from '../src/services/chat/toolBlocks'

describe('searchBlocks', () => {
  it('把结果写成与历史同构的 server_tool_use + web_search_tool_result', () => {
    const blocks = searchBlocks('call_1', 'deepseek v4', [
      { title: 'DeepSeek-V4', url: 'https://zh.wikipedia.org/wiki/DeepSeek', snippet: '摘要' },
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({
      type: 'server_tool_use',
      id: 'tool-call_1',
      name: 'deepseek_web_search',
      kind: 'search',
      input: { action: 'search', query: 'deepseek v4', queries: ['deepseek v4'] },
    })
    expect(blocks[1]).toMatchObject({
      type: 'web_search_tool_result',
      tool_use_id: 'tool-call_1',
      kind: 'search',
      content: [
        {
          type: 'web_search_result',
          title: 'DeepSeek-V4',
          url: 'https://zh.wikipedia.org/wiki/DeepSeek',
          snippet: '摘要',
        },
      ],
    })
  })

  it('0 条结果时列表为空，不是错误', () => {
    const [, result] = searchBlocks('call_2', '没有结果的关键词', [])
    expect(result).toMatchObject({ type: 'web_search_tool_result', content: [] })
  })

  it('满 5 条结果全部保留，顺序不变', () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({
      title: `结果 ${i + 1}`,
      url: `https://site${i + 1}.test/page`,
      snippet: `摘要 ${i + 1}`,
    }))
    const [, result] = searchBlocks('call_3', 'q', hits)
    expect(result.type === 'web_search_tool_result' && result.content).toHaveLength(5)
    expect(
      result.type === 'web_search_tool_result' &&
        result.content.map((item) => item.type === 'web_search_result' && item.url)
    ).toEqual(hits.map((hit) => hit.url))
  })

  it('非 http/https 的链接被丢掉，不渲染成来源', () => {
    const [, result] = searchBlocks('call_4', 'q', [
      { title: '坏链接', url: 'javascript:alert(1)', snippet: '' },
      { title: '好链接', url: 'https://ok.test/', snippet: '' },
    ])
    expect(
      result.type === 'web_search_tool_result' &&
        result.content.map((item) => item.type === 'web_search_result' && item.url)
    ).toEqual(['https://ok.test/'])
  })

  it('失败时只放一个错误项，界面据此显示失败', () => {
    const [, result] = searchBlocks('call_5', 'q', [], true)
    expect(result).toMatchObject({
      content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }],
    })
  })
})

describe('fetchBlocks', () => {
  it('读网页写成 open_page + web_fetch_tool_result', () => {
    const blocks = fetchBlocks('call_6', 'https://example.com/', { title: 'Example Domain' })
    expect(blocks[0]).toMatchObject({
      type: 'server_tool_use',
      name: 'deepseek_read_url',
      kind: 'deep_search',
      input: { action: 'open_page', url: 'https://example.com/' },
    })
    expect(blocks[1]).toMatchObject({
      type: 'web_fetch_tool_result',
      kind: 'deep_search',
      content: { type: 'web_fetch_result', url: 'https://example.com/', published_at: null },
    })
  })

  it('链接不合法时不造块，界面不该出现空来源', () => {
    expect(fetchBlocks('call_7', 'not-a-url')).toEqual([])
    expect(fetchBlocks('call_8', '')).toEqual([])
  })

  it('失败时用抓取错误项', () => {
    const [, result] = fetchBlocks('call_9', 'https://down.test/', undefined, true)
    expect(result).toMatchObject({
      content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
    })
  })
})
