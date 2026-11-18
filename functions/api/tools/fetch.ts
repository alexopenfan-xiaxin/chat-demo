import { currentUser, guarded, json, takeRateLimit, type Env } from '../../../server/auth-core'

/**
 * GET /api/tools/fetch?url=...：模型要读一个网页时，前端调这里，服务端转 Keenable 抓取。
 *
 * 只允许 http/https；正文截断到 8000 字符再回传，免得一个长页面把上下文和费用一起顶爆。
 */

type ToolEnv = Env & { KEENABLE_BASE?: string }

const KEENABLE_BASE = 'https://api.keenable.ai'
const KEENABLE_TITLE = 'ds-chat'
const MAX_CONTENT = 8000

export const onRequestGet = guarded(async (context: { request: Request; env: ToolEnv }) => {
  const { request, env } = context
  const user = await currentUser(request, env.DB)
  if (!user) {
    return json({ error: '请先登录' }, 401)
  }
  const target = new URL(request.url).searchParams.get('url') ?? ''
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return json({ error: '链接格式不对' }, 400)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return json({ error: '只支持 http/https 链接' }, 400)
  }
  if (!(await takeRateLimit(env.DB, `tools:fetch:hour:${user.user.id}`, 60, 3600))) {
    return json({ error: '这个账号的读取额度用完了，过一会儿再试', code: 'user_quota' }, 429)
  }
  if (!(await takeRateLimit(env.DB, `tools:fetch:min:${user.user.id}`, 10, 60))) {
    return json({ error: '读取太频繁了，稍等几秒', code: 'user_rate' }, 429)
  }

  const base = env.KEENABLE_BASE ?? KEENABLE_BASE
  let response: Response
  try {
    response = await fetch(`${base}/v1/fetch/public?url=${encodeURIComponent(parsed.toString())}`, {
      headers: { 'x-keenable-title': KEENABLE_TITLE },
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    return json({ error: '抓取服务暂时不可用', code: 'upstream_down' }, 503)
  }
  if (response.status === 429) {
    return json({ error: '抓取服务全站额度暂时用尽，稍后再试', code: 'upstream_quota' }, 503)
  }
  if (!response.ok) {
    return json({ error: '抓取服务返回异常', code: 'upstream_error' }, 503)
  }
  const payload = (await response.json()) as Record<string, unknown>
  const content = typeof payload.content === 'string' ? payload.content : ''
  return json({
    url: parsed.toString(),
    title: typeof payload.title === 'string' ? payload.title.slice(0, 300) : '',
    content: content.slice(0, MAX_CONTENT),
    truncated: content.length > MAX_CONTENT || payload.truncated === true,
  })
})
