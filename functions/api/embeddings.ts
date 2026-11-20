import { currentUser, guarded, json, takeRateLimit, type Env } from '../../server/auth-core'

/**
 * POST /api/embeddings：把一段段正文换成向量。
 *
 * 记忆内容不进我们这边：这个端点只做一次转发，**不写 D1 / KV / R2，不记正文**，
 * 日志里只允许出现状态码。原文由浏览器发来、算完立刻随响应返回，服务端不留副本。
 *
 * 上游是 OpenAI 兼容的 `{model, input}` → `data[i].embedding`，
 * 实测维度 768、向量已归一化（余弦等于点积）。
 */

type EmbedEnv = Env & {
  QWEN_EMBED_URL?: string
  QWEN_EMBED_MODEL?: string
  QWEN_API_KEY?: string
}

const DEFAULT_URL = 'https://maas-api.cn-huabei-1.xf-yun.com/v2/embeddings'
const DEFAULT_MODEL = 'xop3qwen8bembedding'
/** 单次最多几条、单条最多多少字：超过直接 400，不透传给上游 */
const MAX_TEXTS = 8
const MAX_TEXT_CHARS = 2000
const TIMEOUT_MS = 5000
/** 每个用户每小时 300 次：一轮对话两三跳，够用又不至于被当成免费向量服务 */
const RATE_LIMIT = 300
const RATE_WINDOW = 3600

/** 没配 key 时前端据此把记忆功能置灰，不要崩 */
const UNAVAILABLE = 'embeddings_unavailable'

type EmbeddingPayload = {
  data?: { embedding?: unknown }[]
  model?: unknown
  usage?: unknown
}

/** 校验响应：每条都必须是同样长度的数字数组，否则按上游异常处理 */
const readVectors = (payload: EmbeddingPayload): number[][] | null => {
  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    return null
  }
  const vectors: number[][] = []
  let dim = 0
  for (const item of payload.data) {
    const embedding = item?.embedding
    if (!Array.isArray(embedding) || embedding.length === 0) {
      return null
    }
    if (!embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return null
    }
    if (dim === 0) {
      dim = embedding.length
    } else if (embedding.length !== dim) {
      return null
    }
    vectors.push(embedding as number[])
  }
  return vectors
}

export const onRequestPost = guarded(async (context: { request: Request; env: EmbedEnv }) => {
  const { request, env } = context
  const session = await currentUser(request, env.DB)
  if (!session) {
    return json({ error: '请先登录' }, 401)
  }
  if (!env.QWEN_API_KEY) {
    return json({ error: '记忆功能还没有配置', code: UNAVAILABLE }, 501)
  }
  if (!(await takeRateLimit(env.DB, `embed:${session.user.id}`, RATE_LIMIT, RATE_WINDOW))) {
    return json({ error: '请求太频繁，稍后再试', code: 'rate_limited' }, 429)
  }
  let body: { texts?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: '请求格式不对' }, 400)
  }
  const texts = Array.isArray(body.texts)
    ? body.texts.filter((text): text is string => typeof text === 'string' && text.trim() !== '')
    : []
  if (texts.length === 0) {
    return json({ error: '没有要计算的内容' }, 400)
  }
  if (texts.length > MAX_TEXTS) {
    return json({ error: `一次最多 ${MAX_TEXTS} 条` }, 400)
  }
  if (texts.some((text) => text.length > MAX_TEXT_CHARS)) {
    return json({ error: `单条最多 ${MAX_TEXT_CHARS} 字` }, 400)
  }

  const model = env.QWEN_EMBED_MODEL || DEFAULT_MODEL
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(env.QWEN_EMBED_URL || DEFAULT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.QWEN_API_KEY}`,
      },
      // 上游一条一条算，这里保持顺序与入参一致
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    })
  } catch {
    // 超时或网络失败：只报状态，不带任何请求内容
    return json({ error: '向量服务暂时不可用', code: 'embeddings_failed' }, 502)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    return json({ error: '向量服务暂时不可用', code: 'embeddings_failed' }, 502)
  }
  let payload: EmbeddingPayload
  try {
    payload = (await response.json()) as EmbeddingPayload
  } catch {
    return json({ error: '向量服务返回异常', code: 'embeddings_failed' }, 502)
  }
  const vectors = readVectors(payload)
  if (vectors === null) {
    return json({ error: '向量服务返回异常', code: 'embeddings_failed' }, 502)
  }
  return json(
    {
      vectors,
      dim: vectors[0].length,
      model: typeof payload.model === 'string' && payload.model ? payload.model : model,
    },
    200,
    { 'cache-control': 'no-store' }
  )
})
