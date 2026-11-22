/**
 * 客户端工具的参数校验。
 *
 * 为什么要在执行前判一次：schema 只是模型看到的说明书，模型完全可能发出超长、
 * 类型不对或格式不符的参数。过去一律宽松取值——非字符串当空串、标签静默过滤，
 * 结果是服务端白跑一次请求，或者把「空查询」当成一次真实搜索写进历史，
 * 而模型只知道失败了，不知道错在哪。
 *
 * 这里按工具收口：校验不过的调用不发请求、不动记忆，只回一条 error 让模型自己改。
 * 长度上限与 tools.ts 里声明的 schema 是同一组常量，两边不会漂移。
 */

/** 搜索关键词上限，与服务端 `mapResults` 前的 trim.slice(0, 200) 一致 */
export const SEARCH_QUERY_LIMIT = 200
/** 网址上限，按浏览器与常见服务端的 URL 长度取一个够用又不放任的值 */
export const URL_LIMIT = 2048
/** `memory_edit.id` 既可能是编号也可能是一句定位描述，给它的上限 */
export const MEMORY_ID_LIMIT = 200
/** 单个标签的字数、一条记忆的标签个数 */
export const TAG_LIMIT = 20
export const TAGS_MAX = 6

/** 只认 http/https：其它 scheme 服务端也会拒，别白跑一次 */
const URL_PATTERN = /^https?:\/\/\S+$/i

export type ToolArgsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

const fail = (error: string): ToolArgsResult => ({ ok: false, error })

const asText = (value: unknown): string | null => (typeof value === 'string' ? value : null)

type TagsResult = { ok: true; tags?: string[] } | { ok: false; error: string }

/**
 * 标签：缺省、或 ≤TAGS_MAX 个字数合格的字符串。
 *
 * 不静默过滤：过去 `[123, 'x']` 会被悄悄丢掉 123，模型以为存了。宁可整条拒掉，
 * 让它看到原因重发。空串只是没写内容，不算错。
 */
const readTags = (value: unknown): TagsResult => {
  if (value === undefined || value === null) {
    return { ok: true }
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: 'tags 必须是字符串数组' }
  }
  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'tags 里每一项都必须是字符串' }
    }
    const tag = item.trim()
    if (!tag) {
      continue
    }
    if ([...tag].length > TAG_LIMIT) {
      return { ok: false, error: `每个标签最多 ${TAG_LIMIT} 字` }
    }
    tags.push(tag)
  }
  if (tags.length > TAGS_MAX) {
    return { ok: false, error: `一条记忆最多 ${TAGS_MAX} 个标签` }
  }
  return tags.length > 0 ? { ok: true, tags } : { ok: true }
}

/**
 * 校验并规整一次工具调用的参数。
 *
 * 只做「能不能执行」的判断，业务上限（记忆 200 字、画像 800 字）留给写入层：
 * 那一层的错误文案是用户可见的固定句子，这里再判一次会出现两套说法。
 */
export const parseToolArgs = (name: string, raw: string): ToolArgsResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim() || '{}')
  } catch {
    return fail('参数不是合法的 JSON，请按工具 schema 重新调用')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('参数必须是 JSON 对象')
  }
  const args = { ...(parsed as Record<string, unknown>) }

  if (name === 'web_search') {
    const query = asText(args.query)
    if (query === null) {
      return fail('query 必须是字符串')
    }
    const text = query.trim()
    if (!text) {
      return fail('query 不能为空，请给出具体的搜索关键词')
    }
    if ([...text].length > SEARCH_QUERY_LIMIT) {
      return fail(`query 最多 ${SEARCH_QUERY_LIMIT} 字，请精简后重试`)
    }
    return { ok: true, value: { ...args, query: text } }
  }

  if (name === 'read_url') {
    const url = asText(args.url)
    if (url === null) {
      return fail('url 必须是字符串')
    }
    const text = url.trim()
    if (!URL_PATTERN.test(text)) {
      return fail('url 必须是以 http:// 或 https:// 开头的完整网址')
    }
    if (text.length > URL_LIMIT) {
      return fail(`url 最多 ${URL_LIMIT} 个字符`)
    }
    return { ok: true, value: { ...args, url: text } }
  }

  if (name === 'memory_edit') {
    const id = asText(args.id)
    if (id === null) {
      return fail('id 必须是字符串')
    }
    const text = id.trim()
    if (!text) {
      return fail('id 不能为空：请传记忆编号（如 m3）或一句能定位它的话')
    }
    if ([...text].length > MEMORY_ID_LIMIT) {
      return fail(`id 或定位描述最多 ${MEMORY_ID_LIMIT} 字`)
    }
    args.id = text
  }

  if (name === 'memory_save' || name === 'memory_edit') {
    const content = asText(args.content)
    if (content === null) {
      return fail('content 必须是字符串')
    }
    if (!content.trim()) {
      return fail('content 不能为空')
    }
    const tags = readTags(args.tags)
    if (!tags.ok) {
      return tags
    }
    return {
      ok: true,
      value: tags.tags ? { ...args, content, tags: tags.tags } : { ...args, content },
    }
  }

  if (name === 'memory_update_profile') {
    const fullText = asText(args.full_text)
    if (fullText === null) {
      return fail('full_text 必须是字符串；要清空画像请传空串')
    }
    return { ok: true, value: { ...args, full_text: fullText } }
  }

  // 未知工具交给执行层回「未知工具」，这里不拦
  return { ok: true, value: args }
}

/**
 * 参数被拒时，尽力从原始参数里取出可用于界面卡片的 query/url。
 *
 * 拒绝发生在校验之后，但用户已经在等这次工具调用的结果，卡片该照旧出现
 * （历史里的失败调用同样会显示）。取不到就不造卡片。
 */
export const cardHint = (name: string, raw: string): string => {
  if (name !== 'web_search' && name !== 'read_url') {
    return ''
  }
  try {
    const parsed = JSON.parse(raw.trim() || '{}') as Record<string, unknown>
    const value = name === 'web_search' ? parsed.query : parsed.url
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}
