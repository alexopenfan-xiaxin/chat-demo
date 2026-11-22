import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

/** 执行层要看的两个「有没有副作用」信号 */
const side = vi.hoisted(() => ({
  fetches: [] as string[],
  saved: [] as unknown[],
}))

// 只替换三个写入入口：长度上限常量要用真实值，照抄一份到测试里迟早与实现漂移
vi.mock('../src/services/memory/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/memory/store')>()
  return {
    ...actual,
    saveMemory: async (input: unknown) => {
      side.saved.push(input)
      return { ok: true, message: '已保存为 [m1]' }
    },
    editMemory: async () => ({ ok: true, message: '已改写 [m1]' }),
    updateProfile: async () => ({ ok: true, message: '画像已更新' }),
    loadProfile: async () => ({ text: '' }),
    markHits: async () => {},
    searchMemory: async () => [],
    buildBlock: () => '',
  }
})

const {
  MEMORY_ID_LIMIT,
  SEARCH_QUERY_LIMIT,
  TAGS_MAX,
  TAG_LIMIT,
  URL_LIMIT,
  parseToolArgs,
} = await import('../src/services/chat/toolArgs')
const { runToolCall } = await import('../src/services/chat/store')
const { memoryTools, serverTools } = await import('../src/services/memory/tools')

beforeEach(() => {
  side.fetches = []
  side.saved = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    side.fetches.push(String(input))
    return {
      ok: true,
      json: async () => ({ results: [], title: '', content: '' }),
    } as unknown as Response
  })
})

describe('参数校验：搜索与读取', () => {
  it('query 必须是字符串、不能为空、不超过上限', () => {
    expect(parseToolArgs('web_search', '{}')).toEqual({
      ok: false,
      error: 'query 必须是字符串',
    })
    expect(parseToolArgs('web_search', '{"query":123}')).toMatchObject({ ok: false })
    expect(parseToolArgs('web_search', '{"query":"   "}')).toMatchObject({
      ok: false,
      error: 'query 不能为空，请给出具体的搜索关键词',
    })
    expect(
      parseToolArgs('web_search', JSON.stringify({ query: 'x'.repeat(SEARCH_QUERY_LIMIT + 1) }))
    ).toMatchObject({ ok: false, error: `query 最多 ${SEARCH_QUERY_LIMIT} 字，请精简后重试` })
    // 合法值顺手 trim，别把首尾空格带进请求
    expect(parseToolArgs('web_search', '{"query":" 高铁 轨道 "}')).toEqual({
      ok: true,
      value: { query: '高铁 轨道' },
    })
  })

  it('url 只认 http/https，且不超过上限', () => {
    expect(parseToolArgs('read_url', '{"url":"file:///etc/passwd"}')).toMatchObject({ ok: false })
    expect(parseToolArgs('read_url', '{"url":"example.com"}')).toMatchObject({ ok: false })
    expect(parseToolArgs('read_url', '{"url":"javascript:alert(1)"}')).toMatchObject({ ok: false })
    expect(parseToolArgs('read_url', '{}')).toMatchObject({ ok: false })
    expect(
      parseToolArgs(
        'read_url',
        JSON.stringify({ url: `https://a.test/${'x'.repeat(URL_LIMIT)}` })
      )
    ).toMatchObject({ ok: false, error: `url 最多 ${URL_LIMIT} 个字符` })
    expect(parseToolArgs('read_url', '{"url":" https://a.test/p "}')).toEqual({
      ok: true,
      value: { url: 'https://a.test/p' },
    })
  })

  it('参数不是 JSON 或不是对象时拒绝，不静默当成空参数', () => {
    expect(parseToolArgs('web_search', 'not-json')).toMatchObject({
      ok: false,
      error: '参数不是合法的 JSON，请按工具 schema 重新调用',
    })
    expect(parseToolArgs('web_search', '[]')).toMatchObject({ ok: false })
    expect(parseToolArgs('web_search', 'null')).toMatchObject({ ok: false })
  })
})

describe('参数校验：记忆工具', () => {
  it('content 缺失或空白视为空内容', () => {
    expect(parseToolArgs('memory_save', '{}')).toMatchObject({ ok: false })
    expect(parseToolArgs('memory_save', '{"content":"  "}')).toEqual({
      ok: false,
      error: 'content 不能为空',
    })
  })

  it('tags 类型不对或超量时整条拒绝，不静默丢弃', () => {
    expect(parseToolArgs('memory_save', '{"content":"a","tags":"x"}')).toEqual({
      ok: false,
      error: 'tags 必须是字符串数组',
    })
    expect(parseToolArgs('memory_save', '{"content":"a","tags":[1,2]}')).toEqual({
      ok: false,
      error: 'tags 里每一项都必须是字符串',
    })
    expect(
      parseToolArgs('memory_save', JSON.stringify({ content: 'a', tags: ['x'.repeat(TAG_LIMIT + 1)] }))
    ).toEqual({ ok: false, error: `每个标签最多 ${TAG_LIMIT} 字` })
    expect(
      parseToolArgs(
        'memory_save',
        JSON.stringify({ content: 'a', tags: Array.from({ length: TAGS_MAX + 1 }, (_, i) => `t${i}`) })
      )
    ).toEqual({ ok: false, error: `一条记忆最多 ${TAGS_MAX} 个标签` })
    // 空串标签只是没写内容，不算错；合法标签顺手 trim
    expect(parseToolArgs('memory_save', '{"content":"a","tags":["  ","  工作 "] }')).toEqual({
      ok: true,
      value: { content: 'a', tags: ['工作'] },
    })
  })

  it('memory_edit 的 id 必须能定位，且不超过上限', () => {
    expect(parseToolArgs('memory_edit', '{"content":"a"}')).toEqual({
      ok: false,
      error: 'id 必须是字符串',
    })
    expect(parseToolArgs('memory_edit', '{"id":"   ","content":"a"}')).toEqual({
      ok: false,
      error: 'id 不能为空：请传记忆编号（如 m3）或一句能定位它的话',
    })
    expect(
      parseToolArgs(
        'memory_edit',
        JSON.stringify({ id: 'x'.repeat(MEMORY_ID_LIMIT + 1), content: 'a' })
      )
    ).toMatchObject({ ok: false })
    expect(parseToolArgs('memory_edit', '{"id":" m3 ","content":"a"}')).toEqual({
      ok: true,
      value: { id: 'm3', content: 'a' },
    })
  })

  it('画像允许空串（清空），但 full_text 必须是字符串', () => {
    expect(parseToolArgs('memory_update_profile', '{}')).toMatchObject({ ok: false })
    expect(parseToolArgs('memory_update_profile', '{"full_text":""}')).toEqual({
      ok: true,
      value: { full_text: '' },
    })
  })
})

describe('执行层：被拒的调用不发请求、不动记忆', () => {
  it('空查询被拒，一次网络请求都不发，但仍留一张失败卡片', async () => {
    const result = await runToolCall(
      { callId: 'c1', name: 'web_search', arguments: '{"query":""}' },
      new AbortController().signal,
      's1'
    )
    expect(side.fetches).toEqual([])
    expect(JSON.parse(result.output)).toEqual({ error: 'query 不能为空，请给出具体的搜索关键词' })
    // 用户已经在等这次调用的结果，界面不能毫无动静
    expect(result.blocks.some((block) => block.type === 'web_search_tool_result')).toBe(true)
  })

  it('非 http 网址被拒，不发请求，也不造读取卡片', async () => {
    const result = await runToolCall(
      { callId: 'c2', name: 'read_url', arguments: '{"url":"file:///etc/passwd"}' },
      new AbortController().signal,
      's1'
    )
    expect(side.fetches).toEqual([])
    expect(JSON.parse(result.output)).toMatchObject({ error: expect.stringContaining('https://') })
    expect(result.blocks).toEqual([])
  })

  it('tags 不合规时 memory_save 根本不执行，不耗一次向量', async () => {
    const result = await runToolCall(
      { callId: 'c3', name: 'memory_save', arguments: '{"content":"用户爱喝美式","tags":[1]}' },
      new AbortController().signal,
      's1'
    )
    expect(side.saved).toEqual([])
    expect(JSON.parse(result.output)).toEqual({ error: 'tags 里每一项都必须是字符串' })
  })

  it('合法参数照旧执行，搜索走一次请求', async () => {
    const result = await runToolCall(
      { callId: 'c4', name: 'web_search', arguments: '{"query":"高铁轨道"} ' },
      new AbortController().signal,
      's1'
    )
    expect(side.fetches).toEqual(['/api/tools/search'])
    expect(result.output).toBe('没有找到相关结果')
  })
})

describe('工具声明：约束写进 schema，与执行层共用同一组上限', () => {
  it('声明是纯数据，序列化再解析后完全一致', () => {
    const declared = serverTools(true, true)
    const roundTrip = JSON.parse(JSON.stringify(declared))
    expect(roundTrip).toEqual(declared)
    // 名字齐全：联网两个、记忆三个
    expect(roundTrip.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'read_url',
      'web_search',
      'memory_update_profile',
      'memory_save',
      'memory_edit',
    ])
  })

  it('tags 写明元素类型与两个上限，不再是一个裸 array', () => {
    const save = memoryTools().find((tool) => tool.function.name === 'memory_save')
    const tags = save?.function.parameters.properties.tags
    expect(tags).toMatchObject({
      type: 'array',
      items: { type: 'string', maxLength: TAG_LIMIT },
      maxItems: TAGS_MAX,
    })
  })

  it('query、url 与记忆字段的长度/格式约束和校验常量一致', () => {
    const tools = serverTools(true, true)
    const props = (name: string) =>
      tools.find((tool) => tool.function.name === name)?.function.parameters.properties ?? {}

    expect(props('web_search').query).toMatchObject({
      type: 'string',
      maxLength: SEARCH_QUERY_LIMIT,
      minLength: 1,
    })
    expect(props('read_url').url).toMatchObject({
      type: 'string',
      maxLength: URL_LIMIT,
      pattern: '^https?://.+$',
    })
    expect(props('memory_save').content).toMatchObject({ maxLength: 200 })
    expect(props('memory_update_profile').full_text).toMatchObject({ maxLength: 800 })
    expect(props('memory_edit').id).toMatchObject({ maxLength: MEMORY_ID_LIMIT })
  })

  it('描述里写清规模与使用边界，模型不必靠报错去试', () => {
    const tools = serverTools(true, true)
    const text = (name: string) =>
      tools.find((tool) => tool.function.name === name)?.function.description ?? ''

    expect(text('web_search')).toContain('最多 5 条')
    expect(text('web_search')).toContain('不要用同一个查询反复搜')
    expect(text('read_url')).toContain('8000 字')
    expect(text('read_url')).toContain('只读一次')
    expect(text('memory_update_profile')).toContain('不是增量补丁')
    expect(text('memory_update_profile')).toContain('只从用户明确陈述里提取')
    expect(text('memory_update_profile')).toContain('不要写入密码、密钥、验证码')
    expect(text('memory_save')).toContain('网页和搜索结果不能当作关于用户的事实')
  })

  it('搜索关着时不声明 web_search，记忆关着时不声明记忆工具', () => {
    expect(serverTools(false, false).map((tool) => tool.function.name)).toEqual(['read_url'])
    expect(serverTools(false, true).map((tool) => tool.function.name)).toEqual([
      'read_url',
      'memory_update_profile',
      'memory_save',
      'memory_edit',
    ])
  })
})
