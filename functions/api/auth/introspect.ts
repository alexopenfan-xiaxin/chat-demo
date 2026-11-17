import {
  INTERNAL_HEADER, bad, bearerToken, clientIp, findSession, json, safeEqual, takeRateLimit,
  type Env,
} from '../../../server/auth-core'

/**
 * POST /api/auth/introspect：给本机 proxy 验 Bearer 用。
 * 必须带共享头，否则任何人都能拿这个接口探测 token 是否存在。
 */
export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const { request, env } = context
  const secret = env.INTERNAL_API_SECRET
  if (!secret) {
    return bad('未配置内部密钥', 503)
  }
  if (!safeEqual(request.headers.get(INTERNAL_HEADER) ?? '', secret)) {
    return bad('forbidden', 403)
  }
  // 共享头是唯一的准入凭据，再叠一条高频上限，免得有人拿它当预言机刷会话
  if (!(await takeRateLimit(env.DB, `introspect:ip:${clientIp(request)}`, 3000, 60))) {
    return bad('too many', 429)
  }
  const token = bearerToken(request)
  if (!token) {
    return json({ active: false }, 401)
  }
  const session = await findSession(env.DB, token)
  if (!session) {
    return json({ active: false }, 401)
  }
  return json({ active: true, user: session.user, expiresAt: session.expiresAt })
}
