import { SESSION_COOKIE, currentUser, guarded, json, readCookie, type Env } from '../../server/auth-core'

/**
 * GET /api/credits：当前用户的额度。
 *
 * 数据源是上游的 GET /v1/usage（密钥自鉴权，只回自己那一条，不计调用量）。
 * 现在还没做多 key，所有用户共用同一把 key，所以这里读环境里的那把；
 * 等每用户 key 落地，把「取 key」换成查 D1 即可，其余不变。
 *
 * 上游真实结构（2026-11 v2.11.17 实测，不是顶层平铺）：
 *
 * ```json
 * {
 *   "key":           { "models": ["deepseek-v4.1-flash"], "expires_at": 0 },
 *   "tokens":        { "used": 2837, "limit": null, "remaining": null },
 *   "credits":       { "used": 0,    "limit": null, "remaining": null },
 *   "daily_tokens":  { "used": 2837, "limit": null, "remaining": null }
 * }
 * ```
 *
 * 三个坑都在这张图里：
 * 1. `daily_tokens` 是**对象**不是数字，按数字解析会被整段丢掉；
 * 2. `models` / `expires_at` 在 `key` 下面，顶层取不到；
 * 3. `expires_at: 0` 表示**长期有效**，不是「没有这个字段」，要原样保留 0。
 *
 * 第三个坑不在上游结构里，在 issue #450：`credits` 段没接 `quota_credit`，
 * 恒回 `used: 0`。有用量却「0 积分」不可能成立，所以整段判为不可用
 * （`credits: null`），前端主数字显示 `——`，绝不显示假的 0。
 */
/*
 * ⚠️ 单用户假设（TODO：第二个用户注册前必须改掉）
 *
 * 现在所有用户共用同一把上游 key，`unlimited` 也来自全局配置 UPSTREAM_KEY_UNLIMITED。
 * 这只有在「全站只有一个用户」时才成立：第二个用户注册后，他会看到第一个用户的用量，
 * 而 unlimited 也会把所有人的账号都说成不限额。
 *
 * 多 key 落地时要换掉两处：下面取 key 的地方改成查 D1 里该用户自己的 key，
 * unlimited 改成读那把 key 的 quota_credit 是否为 0。响应形状不用动。
 */
type CreditEnv = Env & {
  /** 上游网关地址，默认与聊天链路同一个 */
  UPSTREAM_BASE?: string
  UPSTREAM_USAGE_KEY?: string
  /** 这把 key 是否不限额（quota 0 的账号），由部署时配置 */
  UPSTREAM_KEY_UNLIMITED?: string
}

type UsageSection = { used?: number | null; limit?: number | null; remaining?: number | null }

type UpstreamUsage = {
  tokens?: UsageSection
  credits?: UsageSection
  daily_tokens?: UsageSection | number | null
  key?: { models?: unknown; expires_at?: unknown }
  snapshot_at?: string | number | null
  [key: string]: unknown
}

export type Section = { used: number | null; limit: number | null; remaining: number | null }

export type UsageSnapshot = {
  unlimited: boolean
  /** null 表示读不到或不可信，前端据此显示 `——` */
  credits: Section | null
  /** credits 段是否可信；false 说明上游 credits 段没接上（issue #450） */
  creditsReliable: boolean
  tokens: Section | null
  dailyTokens: Section | null
  models: string[]
  /** 原样透出上游值：0 = 长期有效，null = 没给 */
  expiresAt: number | string | null
  snapshotAt: string
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const section = (value: unknown): Section | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  return {
    used: num(record.used),
    limit: num(record.limit),
    remaining: num(record.remaining),
  }
}

/** 兼容「对象」和「裸数字」两种形态，前者是上游现在的真实形状 */
const sectionLike = (value: unknown): Section | null => {
  const plain = num(value)
  if (plain !== null) {
    return { used: plain, limit: null, remaining: null }
  }
  return section(value)
}

const toIso = (value: unknown): string => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 小于 1e12 当秒，否则当毫秒
    return new Date(value < 1e12 ? value * 1000 : value).toISOString()
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString()
  }
  return new Date().toISOString()
}

/** 把上游响应规整成前端契约，纯函数，方便单独验证 */
export const parseUsage = (raw: UpstreamUsage, unlimited: boolean): UsageSnapshot => {
  const tokens = section(raw.tokens)
  const rawCredits = section(raw.credits)
  // issue #450：credits.used 恒为 0，而 tokens.used 已经有量时必然矛盾。
  // 此时整段不可信，宁可显示「读不到」也不给用户一个假的 0。
  const creditsReliable = !(rawCredits !== null && (tokens?.used ?? 0) > 0 && (rawCredits.used ?? 0) === 0)

  const key = typeof raw.key === 'object' && raw.key !== null ? raw.key : {}
  const models = Array.isArray(key.models)
    ? key.models.filter((model): model is string => typeof model === 'string')
    : []
  const expiresAt =
    typeof key.expires_at === 'number' || typeof key.expires_at === 'string' ? key.expires_at : null

  return {
    unlimited,
    credits: creditsReliable ? rawCredits : null,
    creditsReliable,
    tokens,
    dailyTokens: sectionLike(raw.daily_tokens),
    models,
    expiresAt,
    // 上游可能给 unix 秒，也可能给 ISO；统一成 ISO，缺失时用本次响应时间
    snapshotAt: toIso(raw.snapshot_at),
  }
}

export const onRequestGet = guarded(async (context: { request: Request; env: CreditEnv }) => {
  const { request, env } = context
  if (!(await currentUser(request, env.DB))) {
    return json({ error: '请先登录' }, 401)
  }
  // 走隧道域名，不碰裸 IP：Worker 直接 fetch 43.226.46.73 会被 Cloudflare 挡成 1003
  const base = (env.UPSTREAM_BASE ?? 'https://api-ds-chat.openfan.dpdns.org').replace(/\/+$/, '')
  // 优先用服务端配置的 key（多 key 方案落地后就是查 D1）；
  // 还没配置时退回到「用户自己在设置里填的那把」，只用于查额度，不留存、不写日志
  const key = env.UPSTREAM_USAGE_KEY ?? request.headers.get('x-usage-key') ?? ''
  if (!key) {
    return json({ error: '额度服务没有配置' }, 503)
  }

  // proxy 的 introspect 读的是同一个会话表、同一种 token 形态，所以直接复用 cookie 里这张票，
  // 不用另签会话（那会每开一次额度页就往 sessions 表插一条垃圾行）
  const cookieToken = readCookie(request, SESSION_COOKIE) ?? ''
  const response = await fetch(`${base}/v1/usage`, {
    headers: {
      authorization: `Bearer ${key}`,
      'x-ds-chat-auth': cookieToken,
      'cache-control': 'no-store',
    },
  })
  if (!response.ok) {
    // 用 503 而不是 502：Pages Functions 返回 502 时 Cloudflare 会用自家的错误页
    // 覆盖 body，前端就拿不到我们写的 JSON 了
    return json({ error: '额度暂时读不到' }, response.status === 429 ? 429 : 503)
  }

  const raw = (await response.json()) as UpstreamUsage
  const snapshot = parseUsage(raw, env.UPSTREAM_KEY_UNLIMITED === '1')

  return json({
    unlimited: snapshot.unlimited,
    credits: snapshot.credits,
    credits_reliable: snapshot.creditsReliable,
    tokens: snapshot.tokens,
    daily_tokens: snapshot.dailyTokens,
    models: snapshot.models,
    expires_at: snapshot.expiresAt,
    snapshot_at: snapshot.snapshotAt,
  })
})
