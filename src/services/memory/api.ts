import { create } from 'zustand'
import { ApiError } from '../api/client.js'
import { ensureAccessToken } from '../auth.js'

/**
 * 向量接口有三条路，顺序是「同源 → 隧道」，直连留而不用：
 *
 * - 同源 Pages Function（主路）：跟聊天同一个域名，手机上必然可达。由 Cloudflare 出口打讯飞，
 *   实测上游往返 4 秒级，所以召回那 800ms 常常只够打完这一跳就换路。
 * - cloudflared 隧道到本机 emb-relay（回退）：本机打讯飞 0.1 秒，隧道往返 p50 约 1.5 秒。
 *   召回在直连超时后补这一次，给 2.5 秒预算。
 * - 公网直连 `emb.openfan.dpdns.org`：手机实测 `ERR_CONNECTION_RESET`，被中途重置，
 *   代码里留着（换机器、换网络时可能又通），但默认不启用。
 *
 * 三条路都带 X-DS-Chat-Auth 票（同源另有 cookie），异源部署同样能验。
 */
const EMBEDDINGS_SAME_ORIGIN = '/api/embeddings'

/** Workers AI 的 bge-m3：同源 `/api/embed`，1024 维 */
const EMBEDDINGS_CF = '/api/embed'

/**
 * 向量模型开关。默认仍是讯飞（qwen）；队长给一句「切」就改成 'cf-bge-m3' 并发版。
 *
 * 两个模型的向量空间不通用：换过去以后旧条目按 `model` 判失效、静默跳过，
 * 由 `reindex.ts` 分批重算。**别在有旧条目的库上只改这一行就上线**，
 * 要先确认重算任务跟着跑起来。
 */
export const EMBEDDINGS_MODEL: EmbeddingModel = 'cf-bge-m3'

/** 本机 emb-relay（隧道路由 emb-ds-chat → 127.0.0.1:18789），保留当备份 */
export const EMBEDDINGS_VIA_TUNNEL = 'https://emb-ds-chat.openfan.dpdns.org/embeddings'

/** 公网直连：DNS only 指到服务器，本机 openresty 443 → emb-relay，不经 Cloudflare 边缘 */
export const EMBEDDINGS_PUBLIC = 'https://emb.openfan.dpdns.org/embeddings'

/**
 * 主路：同源 Pages Function。2026-11-20 由「公网直连」改过来——用户在手机上直连那条
 * 是 net::ERR_CONNECTION_RESET，而走 Cloudflare 的同源那条通。
 */
export const EMBEDDINGS_URL = EMBEDDINGS_SAME_ORIGIN

/** 同源 Pages Function：现在的默认主路 */
export { EMBEDDINGS_SAME_ORIGIN }

/** 召回的回退预算：同源那 800ms 用完后，最多再等这么久走隧道 */
export const RECALL_FALLBACK_TIMEOUT_MS = 2500

/**
 * 预热地址：打隧道那侧的 /warmup，把这张票先验进 relay 的 60 秒缓存。
 * 主路（同源 Pages Function）没有这个 Function，预热对它没用；但回退要多走隧道，
 * 先把验票这一跳做掉，回退那一跳就只剩推理时间。
 */
export const EMBEDDINGS_WARMUP_URL = EMBEDDINGS_VIA_TUNNEL.replace(/\/embeddings$/, '/warmup')

/**
 * 票指纹：预热按「这张票」记标记，不按账号 id。
 *
 * 按账号记的话，会话票到期换新票之后不会再预热，那一轮召回仍要付一次验票
 * （经隧道约 0.9 秒）并可能降级一次。指纹只取 hash 前 8 个十六进制字符，
 * 不落盘、不进日志、也不能反推原票。
 */
export const tokenFingerprint = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest).slice(0, 4), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 预热：登录、换票之后调一次，把这张票在向量接口那一侧验掉。
 *
 * 只验票：不发用户内容、不算向量。失败静默——最坏情况就是首轮检索按老样子
 * 撞上 800ms 超时，降级成只带画像。
 */
export const warmupEmbeddings = async (): Promise<void> => {
  try {
    const token = await ensureAccessToken()
    if (!token) {
      return
    }
    await fetch(EMBEDDINGS_WARMUP_URL, {
      method: 'GET',
      headers: { 'X-DS-Chat-Auth': token },
      credentials: 'same-origin',
    })
  } catch {
    // 预热失败不影响任何功能
  }
}

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

/** 两条通道：公网直连是主路，同源 Pages Function 只给写入当回退 */
export type EmbeddingChannel = 'public' | 'tunnel' | 'same-origin' | 'cf'

/** 能用哪家的向量：讯飞 qwen（768 维）与 Workers AI bge-m3（1024 维） */
export type EmbeddingModel = 'qwen' | 'cf-bge-m3'

/**
 * 失败原因：只用来在 console 里一眼分清是哪一段坏了，界面文案仍然走
 * `embed_failed` 那一条，一个字的用户可见文案都没多出来。
 */
export type EmbeddingFailReason = 'network' | 'timeout' | 'unauthorized' | 'server' | 'protocol'

/** 带通道与原因的失败：`embedTexts` 靠它判断要不要换通道重试 */
export class EmbeddingsRequestError extends ApiError {
  constructor(
    readonly reason: EmbeddingFailReason,
    readonly channel: EmbeddingChannel,
    status?: number
  ) {
    super(reason === 'unauthorized' ? 'session' : reason === 'network' ? 'network' : 'http', '', status)
    this.name = 'EmbeddingsRequestError'
  }
}

/** 只有这三种值得换通道再试一次：401 换条路也还是 401，协议错换条路也还是错 */
const RETRIABLE = new Set<EmbeddingFailReason>(['network', 'timeout', 'server'])

/** 写入的超时：比召回的 800ms 宽得多，但别让用户干等一分钟 */
export const WRITE_TIMEOUT_MS = 6000

/** 校验响应：每条都必须是同样长度的数字数组，否则按协议异常处理 */
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

/**
 * 一次请求。失败按 network / timeout / 401 / 5xx / protocol 分类抛出，
 * 日志里只允许出现通道、原因、状态码、条数与耗时——不出现任何正文。
 */
const request = async (
  url: string,
  channel: EmbeddingChannel,
  texts: string[],
  timeoutMs: number
): Promise<EmbeddingResult> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 同源时靠 cookie；换成另一个域名时靠这张票，两种部署都能用
    const token = await ensureAccessToken()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) {
      headers['X-DS-Chat-Auth'] = token
    }
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ texts }),
        credentials: 'same-origin',
        signal: controller.signal,
      })
    } catch {
      throw new EmbeddingsRequestError(controller.signal.aborted ? 'timeout' : 'network', channel)
    }
    if (response.status === 501) {
      useMemoryStatus.setState({ available: false })
      throw new EmbeddingsUnavailable()
    }
    if (!response.ok) {
      const reason: EmbeddingFailReason =
        response.status === 401 || response.status === 403
          ? 'unauthorized'
          : response.status >= 500
            ? 'server'
            : 'protocol'
      throw new EmbeddingsRequestError(reason, channel, response.status)
    }
    const result = readResult(await response.json().catch(() => null))
    if (!result) {
      throw new EmbeddingsRequestError('protocol', channel, response.status)
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

/** 失败日志：定位用，不含正文；成功换通道也记一行，免得下次又猜 */
const logEmbeddingFailure = (
  error: unknown,
  channel: EmbeddingChannel,
  texts: number,
  timeoutMs: number,
  willRetry: boolean
): void => {
  const reason =
    error instanceof EmbeddingsRequestError
      ? error.reason
      : error instanceof EmbeddingsUnavailable
        ? 'not_configured'
        : 'protocol'
  const status = error instanceof EmbeddingsRequestError ? error.status : undefined
  // eslint-disable-next-line no-console
  console.warn(
    `[memory] 向量请求失败 channel=${channel} reason=${reason}` +
      `${status === undefined ? '' : ` status=${status}`} texts=${texts} timeout=${timeoutMs}ms` +
      `${willRetry ? ' → 换路重试' : ''}`
  )
}

/** 换路的选项：主路失败后换一条再试一次，给这一跳单独的超时 */
export type EmbedOptions = {
  /** 换路预算；不传就不换路（只打主路一次）。写入与召回各自传自己的值 */
  tunnelFallbackTimeoutMs?: number
}

/** 一个模型对应的主路地址与通道名 */
const routeOf = (model: EmbeddingModel): { url: string; channel: EmbeddingChannel } =>
  model === 'cf-bge-m3'
    ? { url: EMBEDDINGS_CF, channel: 'cf' }
    : { url: EMBEDDINGS_SAME_ORIGIN, channel: 'same-origin' }

/** 主路失败后换的那条：bge-m3 换回讯飞同源，讯飞换隧道 */
const fallbackOf = (model: EmbeddingModel): { url: string; channel: EmbeddingChannel } =>
  model === 'cf-bge-m3'
    ? { url: EMBEDDINGS_SAME_ORIGIN, channel: 'same-origin' }
    : { url: EMBEDDINGS_VIA_TUNNEL, channel: 'tunnel' }

/**
 * 算向量。主路由 `model` 决定，失败按 `options` 换一条再试一次。
 *
 * 为什么主路是同源：用户在手机上打开 `emb.openfan.dpdns.org` 直接 ERR_CONNECTION_RESET，
 * 直连那条被中途重置；同源跟聊天同一条腿（进 Cloudflare 边缘），手机上必然可达。
 *
 * 为什么 bge-m3 的降级是讯飞同源：relay 那侧只有讯飞模型，换过去也拿不到 bge；
 * 宁可用另一个模型的向量（条目会记上它自己的 model，召回时按 model 隔离），
 * 也比这次彻底失败强。
 *
 * 401 与协议错误不换路：换个域名同一张票也一样是 401。
 */
export const embedTextsAs = async (
  model: EmbeddingModel,
  texts: string[],
  timeoutMs: number,
  options: EmbedOptions = {}
): Promise<EmbeddingResult> => {
  const route = routeOf(model)
  try {
    const result = await request(route.url, route.channel, texts, timeoutMs)
    useMemoryStatus.setState({ available: true })
    return result
  } catch (error) {
    const budget = options.tunnelFallbackTimeoutMs ?? 0
    const retry = budget > 0 && error instanceof EmbeddingsRequestError && RETRIABLE.has(error.reason)
    logEmbeddingFailure(error, route.channel, texts.length, timeoutMs, retry)
    if (!retry) {
      throw error
    }
    const fallback = fallbackOf(model)
    try {
      const result = await request(fallback.url, fallback.channel, texts, budget)
      useMemoryStatus.setState({ available: true })
      // eslint-disable-next-line no-console
      console.warn(
        `[memory] 向量请求换路成功 channel=${fallback.channel} model=${result.model || 'unknown'} timeout=${budget}ms`
      )
      return result
    } catch (fallbackError) {
      // 换路也失败时抛换路那条的错：它更接近用户这次真正撞上的墙
      logEmbeddingFailure(fallbackError, fallback.channel, texts.length, budget, false)
      throw fallbackError
    }
  }
}

/** 按开关当前选的模型算向量；调用方不用关心是哪一家 */
export const embedTexts = (
  texts: string[],
  timeoutMs: number,
  options: EmbedOptions = {}
): Promise<EmbeddingResult> => embedTextsAs(EMBEDDINGS_MODEL, texts, timeoutMs, options)
