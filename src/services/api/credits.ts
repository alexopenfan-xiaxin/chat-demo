import { ApiError } from './client.js'

/** 一段额度：used / limit / remaining，任一可能为 null（上游给不出） */
export type CreditSection = {
  used: number | null
  limit: number | null
  remaining: number | null
}

export type CreditsSnapshot = {
  /** 不限额度：由后端判定，前端不靠 limit 是否为 null 去猜 */
  unlimited: boolean
  /** null = 读不到或不可信（上游 credits 段坏掉时后端会清空），主数字显示 —— */
  credits: CreditSection | null
  tokens: CreditSection | null
  /** 上游 daily_tokens 是对象，不是数字 */
  dailyTokens: CreditSection | null
  models: string[]
  /** 原样透出：0 = 长期有效，null = 没给 */
  expiresAt: string | number | null
  snapshotAt: string
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const section = (value: unknown): CreditSection | null => {
  const plain = num(value)
  if (plain !== null) {
    return { used: plain, limit: null, remaining: null }
  }
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

/**
 * GET /api/credits：读当前用户的额度快照。
 *
 * 服务端有 30 秒缓存（这条链路走隧道 + 本机 introspect + 上游，一次 7 秒），
 * 所以默认允许命中；用户点刷新时传 `fresh: true`，直接打真实请求。
 */
export const fetchCredits = async (
  apiKey?: string,
  signal?: AbortSignal,
  fresh = false
): Promise<CreditsSnapshot> => {
  const response = await fetch(fresh ? '/api/credits?fresh=1' : '/api/credits', {
    credentials: 'same-origin',
    headers: apiKey ? { 'x-usage-key': apiKey } : undefined,
    signal,
  })
  if (!response.ok) {
    throw new ApiError(response.status === 401 ? 'session' : 'http', `credits ${response.status}`, response.status)
  }
  const body = (await response.json()) as Record<string, unknown>
  const expiresAt = body.expires_at
  return {
    unlimited: body.unlimited === true,
    credits: section(body.credits),
    tokens: section(body.tokens),
    dailyTokens: section(body.daily_tokens),
    models: Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === 'string') : [],
    expiresAt: typeof expiresAt === 'number' || typeof expiresAt === 'string' ? expiresAt : null,
    snapshotAt: typeof body.snapshot_at === 'string' ? body.snapshot_at : new Date().toISOString(),
  }
}
