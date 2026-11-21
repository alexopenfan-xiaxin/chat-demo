import { describe, expect, it } from 'vitest'
import { mapResults } from '../functions/api/tools/search'
import { shapePage } from '../functions/api/tools/fetch'

describe('mapResults', () => {
  it('丢掉没有 url 的条目，其他字段按需回落和截断', () => {
    const hits = mapResults({
      results: [
        { url: 'https://a.test/', title: 't'.repeat(300), snippet: 's'.repeat(700) },
        { title: '没有链接' },
        { url: 'https://b.test/', description: '来自 description' },
        null,
        'garbage',
      ],
    })
    expect(hits).toEqual([
      { title: 't'.repeat(200), url: 'https://a.test/', snippet: 's'.repeat(600) },
      { title: 'https://b.test/', url: 'https://b.test/', snippet: '来自 description' },
    ])
  })

  it('无效条目先被丢掉，不占结果名额', () => {
    const results = [
      { title: '无链接一' },
      { title: '无链接二' },
      ...Array.from({ length: 6 }, (_, i) => ({ url: `https://h${i}.test/` })),
    ]
    const hits = mapResults({ results }, 3)
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://h0.test/',
      'https://h1.test/',
      'https://h2.test/',
    ])
  })

  it('结构不对时返回空数组，不抛异常', () => {
    expect(mapResults(null)).toEqual([])
    expect(mapResults({ results: 'not-an-array' })).toEqual([])
    expect(mapResults({})).toEqual([])
  })
})

describe('shapePage', () => {
  it('正文超过上限时截断并标 truncated', () => {
    const page = shapePage({ title: '长页面', content: 'x'.repeat(9000) }, 'https://a.test/')
    expect(page.content).toHaveLength(8000)
    expect(page.truncated).toBe(true)
    expect(page.title).toBe('长页面')
    expect(page.url).toBe('https://a.test/')
  })

  it('短正文不标 truncated', () => {
    const page = shapePage({ title: 'Example Domain', content: 'hello' }, 'https://example.com/')
    expect(page).toEqual({
      url: 'https://example.com/',
      title: 'Example Domain',
      content: 'hello',
      truncated: false,
    })
  })

  it('上游自己截过的也算截断，标题按 300 截', () => {
    const page = shapePage(
      { title: 'T'.repeat(400), content: 'short', truncated: true },
      'https://a.test/'
    )
    expect(page.title).toHaveLength(300)
    expect(page.truncated).toBe(true)
  })

  it('缺字段或结构不对时给空值，不抛异常', () => {
    expect(shapePage(null, 'https://a.test/')).toEqual({
      url: 'https://a.test/',
      title: '',
      content: '',
      truncated: false,
    })
  })
})
