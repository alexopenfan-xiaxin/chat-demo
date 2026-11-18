import { SESSION_COOKIE, currentUser, guarded, json, readCookie, type Env } from '../../server/auth-core'
import { decryptSecret } from '../../server/keybox'
import { listPanelKeys, pickPanelKey } from '../../server/panel'

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
  /** 面板管理口，只在 /v1/usage 的 credits 段坏掉时用来补一次真实积分 */
  PANEL_ADMIN_USER?: string
  PANEL_ADMIN_PASSWORD?: string
  /** 用户 key 的 AES-GCM 主密钥 */
  KEY_ENC_SECRET?: string
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

/**
 * 缓存时长。这条链路走 隧道 → 本机 proxy（查 D1 做会话 introspect）→ 上游，实测 7 秒，
 * 用户每点一次额度都要盯着空白看七秒。额度本来就不需要秒级刷新，
 * 所以命中缓存直接返回上一次结果；刷新按钮带 `fresh=1` 打真实请求。
 *
 * 只缓存成功响应：上游 401/503 不写缓存，否则「读不到」会被钉住 30 秒。
 */
const CREDITS_CACHE_SECONDS = 30

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

export type StoredKey = { enc: string | null; quota: number | null } | null

/**
 * 由 D1 里存的那份密文解出这个用户的上游 key，并顺便判定是否不限额。
 *
 * 解不出来就返回空 key —— 绝不能回落到全局 UPSTREAM_USAGE_KEY，那是管理员那把，
 * 回落到它等于给「注册成功但建 key 失败」的账号一张无限额通行证。空 key 由调用方
 * 转成 no_key 响应（额度页显示「额度未开通」，proxy 回 403）。
 *
 * 解密函数作为参数传入，测试里可以换成假的，不必真配主密钥。
 */
export const resolveUpstreamKey = async (
  stored: StoredKey,
  env: { KEY_ENC_SECRET?: string; UPSTREAM_KEY_UNLIMITED?: string },
  decrypt: (stored: string, secret: string) => Promise<string | null>
): Promise<{ key: string; unlimited: boolean }> => {
  if (stored?.enc && env.KEY_ENC_SECRET) {
    const plain = await decrypt(stored.enc, env.KEY_ENC_SECRET)
    if (plain) {
      // 面板语义：quota_credit 为 0 就是不限额，不是零额度
      return { key: plain, unlimited: !(typeof stored.quota === 'number' && stored.quota > 0) }
    }
  }
  return { key: '', unlimited: env.UPSTREAM_KEY_UNLIMITED === '1' }
}

export const onRequestGet = guarded(async (context: { request: Request; env: CreditEnv }) => {
  const { request, env } = context
  const user = await currentUser(request, env.DB)
  if (!user) {
    return json({ error: '请先登录' }, 401)
  }
  // 缓存按用户分键：换个人登录绝不能读到别人的额度
  const cacheKey = new Request(`https://ds-chat.internal/api/credits/${encodeURIComponent(user.user.id)}`)
  // 类型来自 DOM lib，没有 Workers 的 caches.default，这里自己窄化
  const cache = typeof caches === 'object' ? (caches as unknown as { default?: Cache }).default : undefined
  const fresh = new URL(request.url).searchParams.get('fresh') === '1'

  if (cache && !fresh) {
    const hit = await cache.match(cacheKey)
    if (hit) {
      return new Response(await hit.text(), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          // 给浏览器的仍是 no-store，30 秒只对服务端缓存生效
          'cache-control': 'no-store',
          'x-credits-cache': 'hit',
        },
      })
    }
  }

  // 走隧道域名，不碰裸 IP：Worker 直接 fetch 43.226.46.73 会被 Cloudflare 挡成 1003
  const base = (env.UPSTREAM_BASE ?? 'https://api-ds-chat.openfan.dpdns.org').replace(/\/+$/, '')

  // 每个用户查自己的那把 key。key 只在服务端解密，浏览器全程接触不到。
  const stored = await env.DB.prepare(
    'SELECT upstream_key_enc AS enc, upstream_key_quota AS quota, upstream_key_name AS keyName FROM users WHERE id = ?'
  )
    .bind(user.user.id)
    .first<{ enc: string | null; quota: number | null; keyName: string | null }>()
  const { key, unlimited } = await resolveUpstreamKey(stored, env, decryptSecret)
  // 没有自己的 key 就没有额度可查。这里也不能回落到 UPSTREAM_USAGE_KEY：
  // 那是管理员那把，回落到它会让没绑 key 的账号看到别人的用量。
  if (!key) {
    return json({ no_key: true, unlimited: false, credits: null, tokens: null }, 200, {
      'cache-control': 'no-store',
    })
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
  const snapshot = parseUsage(raw, unlimited)

  // /v1/usage 的 credits 段没接 quota_credit（issue #450），判为不可信时去面板
  // /api/keys 按 key 名补一次真实 used_credit；面板也读不到就照旧显示「读不到」，不编数。
  let credits = snapshot.credits
  let creditsSource: 'upstream' | 'panel' | null = credits ? 'upstream' : null
  if (!snapshot.creditsReliable) {
    const panelKey = pickPanelKey(await listPanelKeys(env), stored?.keyName ?? null)
    if (panelKey?.usedCredit !== null && panelKey?.usedCredit !== undefined) {
      const quota = panelKey.quotaCredit
      // quota 0 在面板里是「不限额」，不是零额度
      const capped = typeof quota === 'number' && quota > 0
      // 面板按两位小数记账，浮点减法会留下 0.4600000000000001 这种尾巴
      const round2 = (value: number) => Math.round(value * 100) / 100
      credits = {
        used: round2(panelKey.usedCredit),
        limit: capped ? round2(quota as number) : null,
        remaining: capped ? round2(Math.max(0, (quota as number) - panelKey.usedCredit)) : null,
      }
      creditsSource = 'panel'
    }
  }

  const payload = {
    unlimited: snapshot.unlimited,
    credits,
    credits_reliable: creditsSource === 'panel' ? true : snapshot.creditsReliable,
    credits_source: creditsSource,
    tokens: snapshot.tokens,
    daily_tokens: snapshot.dailyTokens,
    models: snapshot.models,
    expires_at: snapshot.expiresAt,
    snapshot_at: snapshot.snapshotAt,
  }

  if (cache) {
    const stored = new Response(JSON.stringify(payload), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `max-age=${CREDITS_CACHE_SECONDS}`,
      },
    })
    try {
      await cache.put(cacheKey, stored)
    } catch (error) {
      // 缓存写失败不影响本次结果，只是下次还得等 7 秒
      // eslint-disable-next-line no-console
      console.warn('credits cache put failed', error)
    }
  }

  return json(payload)
})
