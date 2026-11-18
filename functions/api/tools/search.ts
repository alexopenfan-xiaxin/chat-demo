import {
  currentUser,
  guarded,
  json,
  rateLimitReached,
  takeRateLimit,
  type Env,
} from '../../../server/auth-core'

/**
 * POST /api/tools/search：模型发起联网搜索时，前端调这里，服务端再转 Keenable。
 *
 * 不直连的原因有两个：Keenable 的免 key 额度是按来源 IP 算的（全站共用一个池），
 * 只能在服务端做按用户配额；另外浏览器不该知道我们用了哪家搜索。
 *
 * 限额取「每用户 60 次/小时 + 10 次/分钟」，明显低于 Keenable 全站的 1000/小时，
 * 一个人刷不爆所有人的额度。计数发生在上游成功之后：上游 429/503/超时不是用户的错，
 * 不能让他重试几次就把自己的额度耗光。
 */

type ToolEnv = Env & { KEENABLE_BASE?: string }

const KEENABLE_BASE = 'https://api.keenable.ai'
/** 标识应用的身份头，Keenable 缺这个头会 400；它不是密钥 */
const KEENABLE_TITLE = 'ds-chat'
const MAX_RESULTS = 5

export type SearchHit = { title: string; url: string; snippet: string }

/**
 * 只把模型需要的字段递回去：标题、链接、摘要。
 * 先丢掉没有 url 的条目再截断，否则无效条目会白占名额。
 */
export const mapResults = (payload: unknown, maxResults = MAX_RESULTS): SearchHit[] => {
  const list =
    typeof payload === 'object' && payload !== null && Array.isArray((payload as { results?: unknown }).results)
      ? ((payload as { results: unknown[] }).results)
      : []
  const hits: SearchHit[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const record = item as Record<string, unknown>
    const url = typeof record.url === 'string' ? record.url : ''
    if (!url) {
      continue
    }
    const snippet =
      typeof record.snippet === 'string'
        ? record.snippet
        : typeof record.description === 'string'
          ? record.description
          : ''
    hits.push({
      title: typeof record.title === 'string' ? record.title.slice(0, 200) : url,
      url,
      snippet: snippet.slice(0, 600),
    })
    if (hits.length >= maxResults) {
      break
    }
  }
  return hits
}

export const onRequestPost = guarded(async (context: { request: Request; env: ToolEnv }) => {
  const { request, env } = context
  const user = await currentUser(request, env.DB)
  if (!user) {
    return json({ error: '请先登录' }, 401)
  }
  let body: { query?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: '请求格式不对' }, 400)
  }
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 200) : ''
  if (!query) {
    return json({ error: '搜索词不能为空' }, 400)
  }
  // 两层闸：小时桶管总量，分钟桶管瞬时。这里只读预检，不扣次数
  const hourKey = `tools:search:hour:${user.user.id}`
  const minKey = `tools:search:min:${user.user.id}`
  if (await rateLimitReached(env.DB, hourKey, 60)) {
    return json({ error: '这个账号的搜索额度用完了，过一会儿再试', code: 'user_quota' }, 429)
  }
  if (await rateLimitReached(env.DB, minKey, 10)) {
    return json({ error: '搜索太频繁了，稍等几秒', code: 'user_rate' }, 429)
  }

  const base = env.KEENABLE_BASE ?? KEENABLE_BASE
  let response: Response
  try {
    response = await fetch(`${base}/v1/search/public`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-keenable-title': KEENABLE_TITLE,
      },
      body: JSON.stringify({ query, max_results: MAX_RESULTS }),
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    return json({ error: '搜索服务暂时不可用', code: 'upstream_down' }, 503)
  }
  if (response.status === 429) {
    // 这是全站额度被别处用光，不是这个用户的问题，别记到他头上
    return json({ error: '搜索服务全站额度暂时用尽，稍后再试', code: 'upstream_quota' }, 503)
  }
  if (!response.ok) {
    return json({ error: '搜索服务返回异常', code: 'upstream_error' }, 503)
  }
  const payload = (await response.json()) as unknown
  // 上游成功了才记账：失败不该吃用户的额度
  await takeRateLimit(env.DB, hourKey, 60, 3600)
  await takeRateLimit(env.DB, minKey, 10, 60)
  return json({ query, results: mapResults(payload, MAX_RESULTS) })
})
