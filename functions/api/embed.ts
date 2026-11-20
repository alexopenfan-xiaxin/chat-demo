import { currentUser, guarded, json, takeRateLimit, type Env } from '../../server/auth-core'

/**
 * /api/embed：把正文换成向量，走 Cloudflare Workers AI 的 bge-m3。
 *
 * 为什么另开一个端点：直连 `emb.openfan.dpdns.org` 在手机网络里被 ERR_CONNECTION_RESET 重置，
 * 而 Workers AI 跟聊天同一条腿（进 Cloudflare 边缘），手机上必然可达。bge-m3 输出 1024 维，
 * 与讯飞那条 768 维不通用——**换模型就得重算既有记忆的向量**，所以这个端点先只做探针。
 *
 * 仍然不落盘：不写 D1 / KV / R2，不记正文，日志里只允许出现状态码与耗时。
 *
 * - `POST {texts: string[]}` → `{vectors, dim, model, ms, upstreamMs}`，给前端算向量用；
 * - `GET ?texts=测试` → `{dim, model, ms, upstreamMs}`，只报维度与耗时，不回显任何正文。
 */

type EmbedEnv = Env & { CF_AI_TOKEN?: string; CF_ACCOUNT_ID?: string }

const MODEL = '@cf/baai/bge-m3'
/** 单次最多几条、单条最多多少字：与 /api/embeddings 保持一致，超过直接 400 */
const MAX_TEXTS = 8
const MAX_TEXT_CHARS = 2000
const TIMEOUT_MS = 10_000
/** 250 次/小时：探针连点也够，又不会被当成免费向量服务 */
const RATE_LIMIT = 250
const RATE_WINDOW = 3600

type AiPayload = { result?: { data?: unknown }; success?: boolean }

/** 校验响应：每条都必须是同样长度的数字数组，否则按上游异常处理 */
const readVectors = (payload: AiPayload): number[][] | null => {
  const data = payload.result?.data
  if (!Array.isArray(data) || data.length === 0) {
    return null
  }
  const vectors: number[][] = []
  let dim = 0
  for (const item of data) {
    if (!Array.isArray(item) || item.length === 0) {
      return null
    }
    if (!item.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return null
    }
    if (dim === 0) {
      dim = item.length
    } else if (item.length !== dim) {
      return null
    }
    vectors.push(item as number[])
  }
  return vectors
}

/** 一次推理：返回向量与两段耗时，失败给出状态码供上层决定怎么报 */
const run = async (
  env: EmbedEnv,
  texts: string[]
): Promise<{ vectors: number[][]; upstreamMs: number } | { failed: number }> => {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${MODEL}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.CF_AI_TOKEN}`,
          'content-type': 'application/json',
        },
        // bge-m3 的入参是 {text: string[]}，不是 {input: ...}
        body: JSON.stringify({ text: texts }),
        signal: controller.signal,
      }
    )
  } catch {
    return { failed: 504 }
  } finally {
    clearTimeout(timer)
  }
  const upstreamMs = Date.now() - startedAt
  if (!response.ok) {
    return { failed: response.status === 429 ? 429 : 502 }
  }
  const payload = (await response.json().catch(() => null)) as AiPayload | null
  const vectors = payload ? readVectors(payload) : null
  if (!vectors) {
    return { failed: 502 }
  }
  return { vectors, upstreamMs }
}

/** 取并校验入参；超限返回 null（上层统一报 400） */
const readTexts = (value: unknown): string[] | null => {
  const texts = Array.isArray(value)
    ? value.filter((text): text is string => typeof text === 'string' && text.trim() !== '')
    : []
  if (texts.length === 0 || texts.length > MAX_TEXTS) {
    return null
  }
  if (texts.some((text) => text.length > MAX_TEXT_CHARS)) {
    return null
  }
  return texts
}

const notConfigured = () => json({ error: '向量模型没有配置', code: 'embeddings_unavailable' }, 501)

export const onRequestPost = guarded(async (context: { request: Request; env: EmbedEnv }) => {
  const { request, env } = context
  const startedAt = Date.now()
  const session = await currentUser(request, env.DB)
  if (!session) {
    return json({ error: '请先登录' }, 401)
  }
  if (!env.CF_AI_TOKEN || !env.CF_ACCOUNT_ID) {
    return notConfigured()
  }
  if (!(await takeRateLimit(env.DB, `embed:cf:${session.user.id}`, RATE_LIMIT, RATE_WINDOW))) {
    return json({ error: '请求太频繁，稍后再试', code: 'rate_limited' }, 429)
  }
  let body: { texts?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: '请求格式不对' }, 400)
  }
  const texts = readTexts(body.texts)
  if (!texts) {
    return json({ error: `一次最多 ${MAX_TEXTS} 条、单条最多 ${MAX_TEXT_CHARS} 字` }, 400)
  }
  const result = await run(env, texts)
  if ('failed' in result) {
    return json({ error: '向量计算失败了', code: 'embeddings_failed' }, result.failed)
  }
  return json(
    {
      vectors: result.vectors,
      dim: result.vectors[0].length,
      model: MODEL,
      ms: Date.now() - startedAt,
      upstreamMs: result.upstreamMs,
    },
    200,
    { 'cache-control': 'no-store' }
  )
})

/** GET 探针：手机上点一下就知道这条腿通不通、多快；不回显正文，不返回向量 */
export const onRequestGet = guarded(async (context: { request: Request; env: EmbedEnv }) => {
  const { request, env } = context
  const startedAt = Date.now()
  const session = await currentUser(request, env.DB)
  if (!session) {
    return json({ error: '请先登录' }, 401)
  }
  if (!env.CF_AI_TOKEN || !env.CF_ACCOUNT_ID) {
    return notConfigured()
  }
  if (!(await takeRateLimit(env.DB, `embed:cf:${session.user.id}`, RATE_LIMIT, RATE_WINDOW))) {
    return json({ error: '请求太频繁，稍后再试', code: 'rate_limited' }, 429)
  }
  const raw = new URL(request.url).searchParams.get('texts') ?? ''
  const texts = readTexts([raw])
  if (!texts) {
    return json({ error: `请带一条最多 ${MAX_TEXT_CHARS} 字的内容` }, 400)
  }
  const result = await run(env, texts)
  if ('failed' in result) {
    return json({ error: '向量计算失败了', code: 'embeddings_failed' }, result.failed)
  }
  return json(
    {
      dim: result.vectors[0].length,
      model: MODEL,
      ms: Date.now() - startedAt,
      upstreamMs: result.upstreamMs,
    },
    200,
    { 'cache-control': 'no-store' }
  )
})
