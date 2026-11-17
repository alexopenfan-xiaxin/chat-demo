import { currentUser, guarded, json, type Env } from '../../server/auth-core'

/**
 * GET /api/credits：当前用户的额度。
 *
 * 数据源是上游的 GET /v1/usage（密钥自鉴权，只回自己那一条，不计调用量）。
 * 现在还没做多 key，所有用户共用同一把 key，所以这里读环境里的那把；
 * 等每用户 key 落地，把「取 key」换成查 D1 即可，其余不变。
 *
 * 关键点：`limit: null` 同时表示「不限额」和「上游 credits 段坏了」（issue #450），
 * 前端猜不出来，所以由这里显式给 `unlimited`，取值来自这把 key 的配置而不是 null 推断。
 */
type CreditEnv = Env & {
  /** 上游网关地址，默认与聊天链路同一个 */
  UPSTREAM_BASE?: string
  UPSTREAM_USAGE_KEY?: string
  /** 这把 key 是否不限额（quota 0 的账号），由部署时配置 */
  UPSTREAM_KEY_UNLIMITED?: string
}

type UsageSection = { used?: number; limit?: number | null; remaining?: number | null }

type UpstreamUsage = {
  tokens?: UsageSection
  credits?: UsageSection
  daily_tokens?: number
  models?: string[]
  expires_at?: string | number | null
  snapshot_at?: string | number | null
  [key: string]: unknown
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const section = (source: UsageSection | undefined) => {
  if (!source) {
    return null
  }
  return {
    used: num(source.used),
    limit: num(source.limit),
    remaining: num(source.remaining),
  }
}

export const onRequestGet = guarded(async (context: { request: Request; env: CreditEnv }) => {
  const { request, env } = context
  if (!(await currentUser(request, env.DB))) {
    return json({ error: '请先登录' }, 401)
  }
  const base = (env.UPSTREAM_BASE ?? 'http://43.226.46.73:7864').replace(/\/+$/, '')
  // 优先用服务端配置的 key（多 key 方案落地后就是查 D1）；
  // 还没配置时退回到「用户自己在设置里填的那把」，只用于查额度，不留存、不写日志
  const key = env.UPSTREAM_USAGE_KEY ?? request.headers.get('x-usage-key') ?? ''
  if (!key) {
    return json({ error: '额度服务没有配置' }, 503)
  }

  const response = await fetch(`${base}/v1/usage`, {
    headers: { authorization: `Bearer ${key}`, 'cache-control': 'no-store' },
  })
  if (!response.ok) {
    // 用 503 而不是 502：Pages Functions 返回 502 时 Cloudflare 会用自家的错误页
    // 覆盖 body，前端就拿不到我们写的 JSON 了
    return json({ error: '额度暂时读不到' }, response.status === 429 ? 429 : 503)
  }
  const raw = (await response.json()) as UpstreamUsage
  const tokens = section(raw.tokens)
  const credits = section(raw.credits)
  const unlimited = env.UPSTREAM_KEY_UNLIMITED === '1'

  return json({
    unlimited,
    credits,
    tokens,
    daily_tokens: num(raw.daily_tokens),
    models: Array.isArray(raw.models) ? raw.models : [],
    expires_at: raw.expires_at ?? null,
    // 上游快照时间缺失时用本次响应时间，前端据此显示「刚刚」
    snapshot_at: raw.snapshot_at ?? new Date().toISOString(),
  })
})
