import { create } from 'zustand'
import { ApiError } from '../api/client.js'
import { ensureAccessToken } from '../auth.js'

/**
 * 向量接口地址：默认走同源 Pages Function。
 * 若为了把延迟压进召回预算而改走自建隧道，这里换成一个地址即可，调用方不用动。
 */
export const EMBEDDINGS_URL = '/api/embeddings'

/** 服务端有没有配 key：null 表示还不知道，false 时设置页把记忆开关置灰 */
export const useMemoryStatus = create<{ available: boolean | null }>(() => ({ available: null }))

/**
 * 向量接口客户端：只发正文、只收数字。
 *
 * 服务端（functions/api/embeddings.ts）只做转发，不落盘、不记正文；
 * 这里也不缓存原文，调用方拿到向量就算完。
 */
export type EmbeddingResult = { vectors: number[][]; dim: number; model: string }

/** 服务端没配 key（501）时抛这个：界面据此把记忆功能置灰，不影响聊天 */
export class EmbeddingsUnavailable extends Error {
  constructor() {
    super('embeddings_unavailable')
    this.name = 'EmbeddingsUnavailable'
  }
}

const readResult = (body: unknown): EmbeddingResult | null => {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const payload = body as { vectors?: unknown; dim?: unknown; model?: unknown }
  if (!Array.isArray(payload.vectors) || payload.vectors.length === 0) {
    return null
  }
  const vectors = payload.vectors.filter(
    (vector): vector is number[] =>
      Array.isArray(vector) &&
      vector.length > 0 &&
      vector.every((value) => typeof value === 'number' && Number.isFinite(value))
  )
  if (vectors.length !== payload.vectors.length) {
    return null
  }
  const dim = typeof payload.dim === 'number' ? payload.dim : vectors[0].length
  if (vectors.some((vector) => vector.length !== dim)) {
    return null
  }
  return {
    vectors,
    dim,
    model: typeof payload.model === 'string' ? payload.model : '',
  }
}

/** `timeoutMs` 由调用方决定：召回要短（800ms），写入可以等久一点 */
export const embedTexts = async (texts: string[], timeoutMs: number): Promise<EmbeddingResult> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 同源时靠 cookie；换成另一个域名时靠这张票，两种部署都能用
    const token = await ensureAccessToken()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) {
      headers['X-DS-Chat-Auth'] = token
    }
    const response = await fetch(EMBEDDINGS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ texts }),
      credentials: 'same-origin',
      signal: controller.signal,
    })
    if (response.status === 501) {
      useMemoryStatus.setState({ available: false })
      throw new EmbeddingsUnavailable()
    }
    if (!response.ok) {
      throw new ApiError(response.status === 401 ? 'session' : 'http', '', response.status)
    }
    const result = readResult(await response.json().catch(() => null))
    if (!result) {
      throw new ApiError('protocol', '')
    }
    useMemoryStatus.setState({ available: true })
    return result
  } finally {
    clearTimeout(timer)
  }
}
