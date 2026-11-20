import {
  SESSION_COOKIE,
  currentUser,
  json,
  readCookie,
  sha256Hex,
  type D1Database,
  type Env,
} from '../../server/auth-core'

/**
 * /api/embed：把正文换成向量，走 Cloudflare Workers AI 的 bge-m3。
 *
 * 为什么另开一个端点：直连 `emb.openfan.dpdns.org` 在手机网络里被 ERR_CONNECTION_RESET 重置，
 * 而 Workers AI 跟聊天同一条腿（进 Cloudflare 边缘），手机上必然可达。bge-m3 输出 1024 维，
 * 与讯飞那条 768 维不通用——**换模型就得重算既有记忆的向量**，所以这个端点先只做探针。
 *
 * 仍然不落盘：不写 D1 / KV / R2，不记正文，日志里只允许出现状态码与耗时。
 *
 * 探针响应带逐跳耗时：`authMs`（会话校验，含缓存命中）`limitMs`（限流）`aiMs`（模型那一跳）
 * `ms`（整条请求）。判据要用这四个数，别用推断。
 *
 * - `POST {texts: string[]}` → `{vectors, dim, model, ms, authMs, limitMs, aiMs, upstreamMs}`
 * - `GET ?texts=测试` → `{dim, model, ms, authMs, limitMs, aiMs, upstreamMs}`，不回显正文
 */

type EmbedEnv = Env & { CF_AI_TOKEN?: string; CF_ACCOUNT_ID?: string }

type EmbedContext = {
  request: Request
  env: EmbedEnv
  waitUntil?: (promise: Promise<unknown>) => void
}

const MODEL = '@cf/baai/bge-m3'
/** 单次最多几条、单条最多多少字：与 /api/embeddings 保持一致，超过直接 400 */
const MAX_TEXTS = 8
const MAX_TEXT_CHARS = 2000
const TIMEOUT_MS = 10_000
/** 250 次/小时：探针连点也够，又不会被当成免费向量服务 */
const RATE_LIMIT = 250
const RATE_WINDOW = 3600
/** 会话缓存 60 秒：与 emb-relay 的验票缓存同一口径 */
const SESSION_CACHE_SECONDS = 60
/** 限流落库节奏：攒够 100 次或过了 30 秒才写一次 D1 */
const FLUSH_HITS = 100
const FLUSH_MS = 30_000

type AiPayload = { result?: { data?: unknown }; success?: boolean }

/** Workers 的 `caches.default` 只做最小声明，跟 D1 一样不引额外依赖 */
type EdgeCache = {
  match: (request: Request) => Promise<Response | undefined>
  put: (request: Request, response: Response) => Promise<void>
}
const edgeCache = (): EdgeCache | undefined =>
  (globalThis as { caches?: { default?: EdgeCache } }).caches?.default

const nowMs = () => Date.now()

/* ---- 会话校验：caches.default 按 sha256(token) 缓存 60 秒 ---- */

type CacheEntry = { id: string; email: string; exp: number }

/**
 * 命中缓存就不查 D1；没命中再走 `currentUser` 那套 JOIN。
 *
 * 缓存里自带 `exp`（秒），过期就当作没命中——这样就算缓存比会话活得久，
 * 也不会把一个已过期的会话放进来。缓存键只放 token 的 sha256，不放原票。
 */
const sessionOf = async (
  request: Request,
  env: EmbedEnv
): Promise<{ user: { id: string; email: string }; hit: boolean } | null> => {
  const token = readCookie(request, SESSION_COOKIE)
  if (!token) {
    return null
  }
  const cache = edgeCache()
  const key = new Request(`https://ds-chat.internal/session/${await sha256Hex(token)}`)
  if (cache) {
    const cached = await cache.match(key)
    if (cached) {
      const entry = (await cached.json().catch(() => null)) as CacheEntry | null
      if (entry && entry.exp > Math.floor(Date.now() / 1000)) {
        return { user: { id: entry.id, email: entry.email }, hit: true }
      }
    }
  }
  const session = await currentUser(request, env.DB)
  if (!session) {
    return null
  }
  if (cache) {
    // 会话自身的到期时间从 D1 拿不到（currentUser 只回 id/email），所以缓存 TTL 取 60 秒
    // 与 SESSION_TTL 的较小值由 expires_at 保证：这里只看 60 秒内的有效性。
    const entry: CacheEntry = {
      id: session.user.id,
      email: session.user.email,
      exp: Math.floor(Date.now() / 1000) + SESSION_CACHE_SECONDS,
    }
    await cache
      .put(
        key,
        new Response(JSON.stringify(entry), {
          headers: { 'content-type': 'application/json', 'cache-control': `max-age=${SESSION_CACHE_SECONDS}` },
        })
      )
      .catch(() => undefined)
  }
  return { user: { id: session.user.id, email: session.user.email }, hit: false }
}

/* ---- 限流：实例内存计数，攒批写 D1，不等写入完成 ---- */

type Bucket = { count: number; resetAt: number; pending: number; flushedAt: number }

const buckets = new Map<string, Bucket>()

/** 把攒下的次数补进 D1（加量而非覆盖，避免多个 isolate 互相抹掉） */
const flushBucket = async (db: D1Database, key: string, pending: number, resetAt: number): Promise<void> => {
  if (pending <= 0) {
    return
  }
  const now = Math.floor(Date.now() / 1000)
  await db
    .prepare(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.count + ? END,
         reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END`
    )
    .bind(key, pending, resetAt, now, pending, pending, now, resetAt)
    .run()
}

/**
 * 记账：本地计数直接决定放行与否，D1 只做跨实例的粗略累计。
 * 攒够 FLUSH_HITS 次或过了 FLUSH_MS 就提交一次，**不 await**——
 * 后台写入失败只影响跨实例的精度，不影响这次请求的结论。
 */
const takeLocalLimit = (context: EmbedContext, userId: string): boolean => {
  const key = `embed:cf:${userId}`
  const now = Date.now()
  let bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= Math.floor(now / 1000)) {
    bucket = { count: 0, resetAt: Math.floor(now / 1000) + RATE_WINDOW, pending: 0, flushedAt: now }
    buckets.set(key, bucket)
  }
  bucket.count += 1
  bucket.pending += 1
  if (bucket.pending >= FLUSH_HITS || now - bucket.flushedAt >= FLUSH_MS) {
    const { pending, resetAt } = bucket
    bucket.pending = 0
    bucket.flushedAt = now
    const write = flushBucket(context.env.DB, key, pending, resetAt).catch(() => undefined)
    context.waitUntil?.(write)
  }
  return bucket.count <= RATE_LIMIT
}

/* ---- 模型那一跳 ---- */

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

const run = async (
  env: EmbedEnv,
  texts: string[]
): Promise<{ vectors: number[][]; aiMs: number } | { failed: number }> => {
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
  const aiMs = Date.now() - startedAt
  if (!response.ok) {
    return { failed: response.status === 429 ? 429 : 502 }
  }
  const payload = (await response.json().catch(() => null)) as AiPayload | null
  const vectors = payload ? readVectors(payload) : null
  if (!vectors) {
    return { failed: 502 }
  }
  return { vectors, aiMs }
}

/* ---- 入参校验 ---- */

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

/** 逐跳耗时：四个数一起回，定位时不用猜 */
type Timings = { ms: number; authMs: number; limitMs: number; aiMs: number }
const timingsOf = (startedAt: number, authMs: number, limitMs: number, aiMs: number): Timings => ({
  ms: Date.now() - startedAt,
  authMs,
  limitMs,
  aiMs,
})

export const onRequestPost = async (context: EmbedContext): Promise<Response> => {
  const { request, env } = context
  const startedAt = nowMs()
  try {
    const authStarted = nowMs()
    const session = await sessionOf(request, env)
    const authMs = nowMs() - authStarted
    if (!session) {
      return json({ error: '请先登录' }, 401)
    }
    if (!env.CF_AI_TOKEN || !env.CF_ACCOUNT_ID) {
      return notConfigured()
    }
    const limitStarted = nowMs()
    const allowed = takeLocalLimit(context, session.user.id)
    const limitMs = nowMs() - limitStarted
    if (!allowed) {
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
      return json(
        { error: '向量计算失败了', code: 'embeddings_failed', ...timingsOf(startedAt, authMs, limitMs, 0) },
        result.failed
      )
    }
    return json(
      {
        vectors: result.vectors,
        dim: result.vectors[0].length,
        model: MODEL,
        ...timingsOf(startedAt, authMs, limitMs, result.aiMs),
        upstreamMs: result.aiMs,
      },
      200,
      { 'cache-control': 'no-store' }
    )
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('embed handler failed', error)
    return json({ error: '服务器出了点问题，稍后再试' }, 500)
  }
}

/** GET 探针：手机上点一下就知道这条腿通不通、多快；不回显正文，不返回向量 */
export const onRequestGet = async (context: EmbedContext): Promise<Response> => {
  const { request, env } = context
  const startedAt = nowMs()
  try {
    const authStarted = nowMs()
    const session = await sessionOf(request, env)
    const authMs = nowMs() - authStarted
    if (!session) {
      return json({ error: '请先登录' }, 401)
    }
    if (!env.CF_AI_TOKEN || !env.CF_ACCOUNT_ID) {
      return notConfigured()
    }
    const limitStarted = nowMs()
    const allowed = takeLocalLimit(context, session.user.id)
    const limitMs = nowMs() - limitStarted
    if (!allowed) {
      return json({ error: '请求太频繁，稍后再试', code: 'rate_limited' }, 429)
    }
    const texts = readTexts([new URL(request.url).searchParams.get('texts') ?? ''])
    if (!texts) {
      return json({ error: `请带一条最多 ${MAX_TEXT_CHARS} 字的内容` }, 400)
    }
    const result = await run(env, texts)
    if ('failed' in result) {
      return json(
        { error: '向量计算失败了', code: 'embeddings_failed', ...timingsOf(startedAt, authMs, limitMs, 0) },
        result.failed
      )
    }
    return json(
      {
        dim: result.vectors[0].length,
        model: MODEL,
        ...timingsOf(startedAt, authMs, limitMs, result.aiMs),
        upstreamMs: result.aiMs,
      },
      200,
      { 'cache-control': 'no-store' }
    )
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('embed handler failed', error)
    return json({ error: '服务器出了点问题，稍后再试' }, 500)
  }
}
