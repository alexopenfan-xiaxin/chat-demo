import { translate, type TranslationMessage } from '../../i18n/index.js'
import { ensureAccessToken, notifySessionExpired } from '../auth.js'
import { setServiceUnavailable } from '../sessionState.js'
import { readServerSentEvents } from './sse.js'
import {
  itemKind,
  readDelta,
  readFunctionCall,
  readFailure,
  readResponseMeta,
  readStopReason,
  readUsage,
  toResponsesBody,
} from './responses.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；传空串表示与页面同源（走 Pages Functions 转发） */
export const API_ORIGIN = __API_ORIGIN__
/** OpenAI 兼容接口的前缀 */
const OPENAI_BASE_URL = `${API_ORIGIN}/v1`

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'
  /** ds-chat 自己的会话过期（proxy 拒了 Bearer），和上游 API Key 失效是两回事 */
  | 'session'
  /** proxy 的会话校验服务暂时不可用（503）：不是登录态问题，别踢人 */
  | 'unavailable'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number,
    /** 上游 error.code，例如 quota_exhausted：只用来分类，不展示给用户 */
    readonly code?: string
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  let code: string | undefined
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
      // 额度耗尽是 429，光看状态码会跟限流混成一件事，所以把 code 带出来供分类
      code = typeof body.error.code === 'string' ? body.error.code : undefined
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status, code)
}

/** proxy 的 401 判定：优先读 WWW-Authenticate，读不到再看 body 里的 code */
const isSessionExpired = async (response: Response): Promise<boolean> => {
  if ((response.headers.get('www-authenticate') ?? '').includes('realm="ds-chat"')) {
    return true
  }
  try {
    const body = (await response.json()) as { error?: { code?: unknown } }
    return body.error?.code === 'session_expired'
  } catch {
    return false
  }
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    const headers = new Headers(init.headers)
    if (API_ORIGIN !== '') {
      // 同源部署直接靠 cookie；独立域名必须带票，proxy 只认这个头
      const token = await ensureAccessToken()
      if (token !== null) {
        headers.set('X-DS-Chat-Auth', token)
      }
    }
    response = await fetch(url, { ...init, headers })
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    // 503 必须排在 401 之前判：introspect 一抖，proxy 就回 503，
    // 当成会话失效会把用户踢回登录页，等于把后端的故障放大一次。
    if (response.status === 503 && API_ORIGIN !== '') {
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as { error?: { code?: unknown } } | null
      if (body?.error?.code === 'service_unavailable') {
        setServiceUnavailable(true)
        throw new ApiError('unavailable', translate('authServiceUnavailable'), 503)
      }
    }
    if (
      response.status === 401 &&
      API_ORIGIN !== '' &&
      (await isSessionExpired(response.clone()))
    ) {
      notifySessionExpired()
      throw new ApiError('session', translate('authSessionExpired'), 401)
    }
    throw await readErrorResponse(response)
  }
  return response
}

/** 用 GET /v1/models 校验 API Key（不产生费用） */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await request(`${OPENAI_BASE_URL}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

/** 当前接口没有 Files API，附件上传直接失败并说明原因，不发出注定 404 的请求 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  // 参数与完整实现保持一致，方便接上支持 Files API 的服务端时替换函数体
  void apiKey
  void purpose
  void signal
  throw new ApiError('http', `当前接口不支持上传附件：${file.name}`)
}

/** 没有上传成功的文件，删除无需请求服务端 */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  void apiKey
  void fileId
}

/**
 * POST /v1/responses（stream: true），握手 Responses 流并翻译成本地事件。
 * 思考档位由请求体的 thinking 决定，关闭时不产出思考块；收到 completed / incomplete 结束。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  // key 不再由浏览器携带：proxy 按会话查出这个用户自己的 key 再注入，
  // 这里带来的任何 Authorization 都会被它丢掉
  void apiKey
  const response = await request(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(toResponsesBody(body)),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  /** 是否展示思考，关闭时不产出思考块，只保留正文 */
  const showThinking = body.thinking.type === 'enabled'
  /** 本地事件模型的块号，按输出项出现的顺序递增 */
  let nextIndex = 0
  let thinkingIndex: number | null = null
  let textIndex: number | null = null

  for await (const { data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (!isRecord(payload) || typeof payload.type !== 'string') {
      continue
    }
    switch (payload.type) {
      case 'response.created': {
        const meta = readResponseMeta(payload)
        yield { type: 'message_start', message: { id: meta.id, model: meta.model } }
        break
      }
      case 'response.output_item.added': {
        const kind = itemKind(payload.item)
        if (kind === 'reasoning' && showThinking) {
          thinkingIndex = nextIndex++
          yield {
            type: 'content_block_start',
            index: thinkingIndex,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          }
        } else if (kind === 'message') {
          textIndex = nextIndex++
          yield {
            type: 'content_block_start',
            index: textIndex,
            content_block: { type: 'text', text: '' },
          }
        }
        break
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = readDelta(payload)
        if (thinkingIndex === null || delta === null) {
          break
        }
        yield {
          type: 'content_block_delta',
          index: thinkingIndex,
          delta: { type: 'thinking_delta', thinking: delta },
        }
        break
      }
      case 'response.output_text.delta': {
        const delta = readDelta(payload)
        if (textIndex === null || delta === null) {
          break
        }
        yield {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text: delta },
        }
        break
      }
      case 'response.output_item.done': {
        const kind = itemKind(payload.item)
        if (kind === 'function_call') {
          const call = readFunctionCall(payload.item)
          if (call) {
            yield { type: 'tool_call', call }
          }
          break
        }
        if (kind === 'reasoning' && thinkingIndex !== null) {
          yield { type: 'content_block_stop', index: thinkingIndex }
          thinkingIndex = null
        } else if (kind === 'message' && textIndex !== null) {
          yield { type: 'content_block_stop', index: textIndex }
          textIndex = null
        }
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        yield {
          type: 'message_delta',
          delta: { stop_reason: readStopReason(payload), stop_sequence: null },
          usage: readUsage(payload),
        }
        yield { type: 'message_stop' }
        return
      }
      case 'response.failed':
      case 'error': {
        throw new ApiError('stream', readFailure(payload, '生成失败'))
      }
      default:
        break
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
