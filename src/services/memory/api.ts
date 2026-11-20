import { create } from 'zustand'
import { ApiError } from '../api/client.js'
import { ensureAccessToken } from '../auth.js'

/**
 * 向量接口可以走两条路，切换只改文件末尾那一行，调用方不用动：
 *
 * - 同源 Pages Function：由 Cloudflare 出口打讯飞。实测上游往返 4 秒级，召回预算 800ms 打不住。
 * - cloudflared 隧道到本机 emb-relay：本机打讯飞只要 0.1 秒，但隧道本身的往返
 *   实测 TTFB p50 2.0 秒（min 0.97 / p90 3.26 / 偶发 6～25 秒），端到端 p50 2.3 秒。
 *
 * 两条路都带 X-DS-Chat-Auth 票（同源另有 cookie），异源部署同样能验。
 */
const EMBEDDINGS_SAME_ORIGIN = '/api/embeddings'

/** 本机 emb-relay（隧道路由 emb-ds-chat → 127.0.0.1:18789），保留当备份 */
export const EMBEDDINGS_VIA_TUNNEL = 'https://emb-ds-chat.openfan.dpdns.org/embeddings'

/** 公网直连：DNS only 指到服务器，本机 openresty 443 → emb-relay，不经 Cloudflare 边缘 */
export const EMBEDDINGS_PUBLIC = 'https://emb.openfan.dpdns.org/embeddings'

/**
 * 切换点：走公网直连。
 *
 * 三条路的实测差距：同源 Pages Function 4 秒级；隧道 1.4 秒（边缘 AMS → 隧道 lax，
 * 绕了半个地球）；公网直连预热后 0.12～0.39 秒。预取虽然把这一跳挪进了打字停顿，
 * 但只有公网这条能让请求在按下发送前真的到账。
 *
 * 回退：换成 EMBEDDINGS_VIA_TUNNEL 或 EMBEDDINGS_SAME_ORIGIN，都是一行。
 */
export const EMBEDDINGS_URL = EMBEDDINGS_PUBLIC

/** 同源 Pages Function 这条备用，切回时用 */
export { EMBEDDINGS_SAME_ORIGIN }

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
