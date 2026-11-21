/**
 * OpenAI Responses 格式（POST /v1/responses）的请求转换与流事件解析。
 *
 * 本应用内部沿用内容块 + 流事件的结构，这层只做协议翻译：
 * 请求方向把 Messages 风格的消息列表拍平成 input 数组，reasoning.effort 固定 low
 * （用户 11-20 要求思考别太费）；
 * 响应方向把 Responses 的输出项与增量事件翻译成本地事件，交给上层的 applyEvent 合并。
 *
 * 注意：「显示思考过程」开关**不进请求体**。实测上游既不认 thinking.type=disabled、
 * 也不认 reasoning.enabled=false，两种写法 reasoning_tokens 都还在 74~104（与 effort=low
 * 的 66~95 同一噪声区间），所以这个开关只决定界面要不要展示思考块（见 client.ts 的
 * showThinking），不改变上游的思考量。
 */

import type { CreateMessageRequest, MessageParam, MessageUsage } from './types.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** 示例内置的模型名与服务端实际模型不一致时用这张表兜底 */
const MODEL_ALIAS: Record<string, string> = {
  'deepseek-flash': 'deepseek-v4.1-flash',
  'deepseek-v4-pro': 'deepseek-v4.1-flash',
}

/** 服务端默认模型，模型名不在别名表里时原样下发 */
export const DEFAULT_MODEL = 'deepseek-v4.1-flash'

/** input 数组里的一项；纯文本对话只需要字符串内容 */
type ResponsesInputItem = { role: 'user' | 'assistant'; content: string }

/** 消息内容里能取到正文的块；其余块（附件、工具调用）当前接口不支持，直接丢弃 */
type TextCarrier = { type: string; text?: string }

/** 取消息里的纯文本 */
const textOf = (content: string | readonly TextCarrier[]): string =>
  typeof content === 'string'
    ? content
    : content
        .flatMap((block) =>
          block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
        )
        .join('\n\n')

/** 相邻的同角色消息合并成一段，避免出现连续的相同 role */
const append = (input: ResponsesInputItem[], role: ResponsesInputItem['role'], text: string) => {
  if (!text.trim()) {
    return
  }
  const last = input.at(-1)
  if (last && last.role === role) {
    last.content = `${last.content}\n\n${text}`
    return
  }
  input.push({ role, content: text })
}

/**
 * 把请求体转成 Responses 格式：
 * - system 走 instructions，latest_reminder 拼进紧随其后的那条提问；
 * - 历史回答只回传正文，思考与工具块不下发（服务端不接受这类结构）；
 * - 思考强度恒为 low，与界面开关无关（上游不认关闭字段，详见文件头）。
 */
export const toResponsesBody = (body: CreateMessageRequest) => {
  const input: ResponsesInputItem[] = []
  let reminder = ''
  for (const message of body.messages as MessageParam[]) {
    if (message.role === 'latest_reminder') {
      reminder = reminder ? `${reminder}\n\n${message.content}` : message.content
      continue
    }
    if (message.role === 'user') {
      const text = [textOf(message.content), reminder].filter((part) => part !== '').join('\n\n')
      reminder = ''
      append(input, 'user', text)
      continue
    }
    append(input, 'assistant', textOf(message.content))
  }
  // 工具往返必须排在用户消息之后、按发生顺序：function_call 与它的 output 成对出现
  for (const item of body.toolExchange ?? []) {
    input.push(item as unknown as ResponsesInputItem)
  }
  return {
    model: MODEL_ALIAS[body.model] ?? body.model ?? DEFAULT_MODEL,
    instructions: body.system,
    input,
    stream: true,
    tool_choice: body.tools.length > 0 ? 'auto' : undefined,
    tools: body.tools,
    // 思考强度开、关都传 low：用户 11-20 要求「思考别那么费」。
    // 开关只决定要不要思考（thinking.type），不再影响强度。
    reasoning: { effort: 'low' },
  }
}

/**
 * 读 Responses 的 usage，缺失的字段按 0 处理。
 *
 * 真实的 `response.completed` / `response.incomplete` 事件把 usage 放在 `response` 里面，
 * 不是在事件顶层；早期我们只认顶层，真机上就一直读到空、环显示「已用 0 / 1M」。
 * 两种形状都收，免得上游哪天换回来又坏一次。
 */
export const readUsage = (value: unknown): MessageUsage | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const usage = isRecord(value.usage)
    ? value.usage
    : isRecord(value.response) && isRecord(value.response.usage)
      ? value.response.usage
      : null
  if (!usage) {
    return undefined
  }
  const cached =
    isRecord(usage.input_tokens_details) && isNumber(usage.input_tokens_details.cached_tokens)
      ? usage.input_tokens_details.cached_tokens
      : 0
  return {
    input_tokens: isNumber(usage.input_tokens) ? usage.input_tokens : 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: isNumber(usage.output_tokens) ? usage.output_tokens : 0,
  }
}

export type ResponsesItemKind = 'reasoning' | 'message' | 'function_call' | 'other'

/** 输出项类型：reasoning 是思考，message 是正文，其余（工具调用等）不参与展示 */
export const itemKind = (item: unknown): ResponsesItemKind => {
  if (!isRecord(item)) {
    return 'other'
  }
  if (item.type === 'reasoning') {
    return 'reasoning'
  }
  if (item.type === 'function_call') {
    return 'function_call'
  }
  return item.type === 'message' ? 'message' : 'other'
}

/** 读一条 function_call：call_id、名称、参数 JSON 原文 */
export const readFunctionCall = (
  item: unknown
): { callId: string; name: string; arguments: string } | null => {
  if (!isRecord(item) || item.type !== 'function_call') {
    return null
  }
  const callId = isString(item.call_id) ? item.call_id : isString(item.id) ? item.id : ''
  const name = isString(item.name) ? item.name : ''
  if (!callId || !name) {
    return null
  }
  return { callId, name, arguments: isString(item.arguments) ? item.arguments : '{}' }
}

export const readResponseMeta = (value: unknown): { id: string; model: string } => {
  if (!isRecord(value) || !isRecord(value.response)) {
    return { id: '', model: '' }
  }
  const { response } = value
  return {
    id: isString(response.id) ? response.id : '',
    model: isString(response.model) ? response.model : '',
  }
}

/** 结束时读 status：incomplete 视为输出上限，其余按正常结束 */
export const readStopReason = (value: unknown): 'end_turn' | 'max_tokens' => {
  if (!isRecord(value) || !isRecord(value.response)) {
    return 'end_turn'
  }
  return value.response.status === 'incomplete' ? 'max_tokens' : 'end_turn'
}

/** 失败事件的报错文案，取不到就用兜底文案 */
export const readFailure = (value: unknown, fallback: string): string => {
  if (isRecord(value)) {
    if (isRecord(value.error) && isString(value.error.message)) {
      return value.error.message
    }
    if (isRecord(value.response) && isRecord(value.response.error)) {
      const { error } = value.response
      if (isString(error.message)) {
        return error.message
      }
    }
    if (isString(value.message)) {
      return value.message
    }
  }
  return fallback
}

/** 增量事件的文本内容 */
export const readDelta = (value: unknown): string | null =>
  isRecord(value) && isString(value.delta) ? value.delta : null
