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
  const token = bearerToken(request)
  // 限流键按 token 算，不按来源 IP：调用方是本机 proxy，cf-connecting-ip 永远是同一个，
  // 按 IP 限会退化成全站共享配额，一个人刷就能让所有人掉线。
  if (!(await takeRateLimit(env.DB, `introspect:tok:${await sha256Hex(token ?? '')}`, 120, 60))) {
    return bad('too many', 429)
  }
  // 兜底：整体被打爆时仍然要挡，但阈值放到正常流量远远碰不到的量级
  if (!(await takeRateLimit(env.DB, 'introspect:all', 20000, 60))) {
    return bad('too many', 429)
  }
  if (!token) {
    return json({ active: false }, 401)
  }
  const session = await findSession(env.DB, token)
  if (!session) {
    return json({ active: false }, 401)
  }
  return json({ active: true, user: session.user, expiresAt: session.expiresAt })
}
