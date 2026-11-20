import type {
  ServerToolUseBlock,
  WebFetchToolResultBlock,
  WebSearchToolResultBlock,
} from '../api/types.js'
import type { MemoryFailReason } from '../memory/reasons.js'
import type { ReplyBlock } from './types.js'
import { isWebUrl } from '../../utils/url.js'

/**
 * 把客户端工具的执行结果写成「服务端搜索」那种内容块。
 *
 * 为什么要同构：渲染层（`view.ts`）只认 `server_tool_use` +
 * `web_search_tool_result` / `web_fetch_tool_result` 这一套结构，历史导入走的就是它。
 * 我们自己的工具是把结果以纯文本回传给模型的，界面因此一片安静。
 * 在这里补上与历史同构的块，界面就能画出「搜索了 N 个网页」和思考里的搜索步骤，
 * 渲染层一行都不用改。
 *
 * 注意这些块不会进上游请求：`toAssistantParam` 只回传 `kind === 'read_link'` 的调用，
 * `search` / `deep_search` 一律被过滤。`read_url` 特意不用 `read_link`——那个分支要求
 * 页面签名，我们没有，塞进去只会变成立即失效的条目。
 */

export type SearchHit = { title: string; url: string; snippet: string }

/** 一次搜索的结果块：成功时是结果列表（可以为空），失败时是一个错误项 */
export const searchBlocks = (
  callId: string,
  query: string,
  results: readonly SearchHit[],
  failed = false
): ReplyBlock[] => {
  const id = `tool-${callId}`
  const use: ServerToolUseBlock = {
    type: 'server_tool_use',
    id,
    name: 'deepseek_web_search',
    input: { action: 'search', ...(query ? { query } : {}), queries: query ? [query] : [] },
    caller: { type: 'direct' },
    kind: 'search',
  }
  const result: WebSearchToolResultBlock = {
    type: 'web_search_tool_result',
    tool_use_id: id,
    kind: 'search',
    content: failed
      ? [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
      : results
          .filter((item) => isWebUrl(item.url))
          .map((item) => ({
            type: 'web_search_result' as const,
            title: item.title,
            url: item.url,
            snippet: item.snippet,
            site_icon: null,
            site_name: null,
            encrypted_content: '',
            page_age: null,
          })),
  }
  return [use, result]
}

/** 一次网页读取的结果块；url 为空时不造块（没有可展示的链接） */
export const fetchBlocks = (
  callId: string,
  url: string,
  page?: { title: string | null },
  failed = false
): ReplyBlock[] => {
  if (!isWebUrl(url)) {
    return []
  }
  const id = `tool-${callId}`
  const use: ServerToolUseBlock = {
    type: 'server_tool_use',
    id,
    name: 'deepseek_read_url',
    input: { action: 'open_page', url },
    caller: { type: 'direct' },
    kind: 'deep_search',
  }
  const result: WebFetchToolResultBlock = {
    type: 'web_fetch_tool_result',
    tool_use_id: id,
    kind: 'deep_search',
    content: failed
      ? { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' }
      : {
          type: 'web_fetch_result',
          url,
          content: {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: '' },
            title: page?.title ?? null,
          },
          published_at: null,
        },
  }
  return [use, result]
}

/**
 * 记忆工具的动作记录块：一次调用一行，按调用顺序排（调用方按 runToolCall 的返回顺序追加）。
 *
 * 只保留动作与条数：用户明确要求「不用显示具体记了啥、改了啥」，所以这里
 * 不出现正文、不出现 id、不出现旧→新。失败原因也只给归类后的短文案，
 * 因为底层失败信息里可能带出相近条目的正文（memory_save 的冲突提示就是那样）。
 */
export const memoryActionBlocks = (
  callId: string,
  action: 'save' | 'edit' | 'profile',
  ok: boolean,
  failureReason?: MemoryFailReason
): ReplyBlock[] => [
  {
    type: 'memory_action',
    id: `memory-${callId}`,
    action,
    count: ok ? 1 : 0,
    // 只写枚举：界面上不可能出现任何自由文本，正文自然漏不进去
    ...(ok ? {} : { failureReason: failureReason ?? 'embed_failed' }),
  },
]

/**
 * 历史兼容：旧消息块里存的是 i18n key，这里只为读得懂老数据保留。
 * 新写入一律走 `failureReason` 枚举，不再从文案反推。
 */
export const memoryFailureKey = (message: string): string => {
  if (message.includes('没有那么配置') || message.includes('还没有配置')) {
    return 'memoryActionFailedUnavailable'
  }
  if (message.includes('向量')) {
    return 'memoryActionFailedEmbedding'
  }
  if (message.includes('最多')) {
    return 'memoryActionFailedTooLong'
  }
  if (message.includes('没有找到明确对应')) {
    return 'memoryActionFailedAmbiguous'
  }
  if (message.includes('没有这条记忆')) {
    return 'memoryActionFailedMissing'
  }
  if (message.includes('相近')) {
    return 'memoryActionFailedConflict'
  }
  if (message.includes('为空')) {
    return 'memoryActionFailedEmpty'
  }
  return 'memoryActionFailedUnknown'
}
