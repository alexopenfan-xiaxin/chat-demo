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
  credits: CreditSection | null
  tokens: CreditSection | null
  dailyTokens: number | null
  models: string[]
  expiresAt: string | null
  snapshotAt: string
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const section = (value: unknown): CreditSection | null => {
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

/** GET /api/credits：读当前用户的额度快照 */
export const fetchCredits = async (apiKey?: string, signal?: AbortSignal): Promise<CreditsSnapshot> => {
  const response = await fetch('/api/credits', {
    credentials: 'same-origin',
    headers: apiKey ? { 'x-usage-key': apiKey } : undefined,
    signal,
  })
  if (!response.ok) {
    throw new ApiError(response.status === 401 ? 'session' : 'http', `credits ${response.status}`, response.status)
  }
  const body = (await response.json()) as Record<string, unknown>
  return {
    unlimited: body.unlimited === true,
    credits: section(body.credits),
    tokens: section(body.tokens),
    dailyTokens: num(body.daily_tokens),
    models: Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === 'string') : [],
    expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null,
    snapshotAt: typeof body.snapshot_at === 'string' ? body.snapshot_at : new Date().toISOString(),
  }
}
