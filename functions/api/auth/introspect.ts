import {
INTERNAL_HEADER, bad, bearerToken, findSessionWithKey, json, safeEqual, takeRateLimit,
  type Env,
} from '../../../server/auth-core'
import { decryptSecret } from '../../../server/keybox'

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
  // 这里的键天然是全站唯一（调用方是本机 proxy），所以只是防整体打爆的兜底闸，
  // 不承担按用户限流；按用户的限流在 proxy 侧做（CF-Connecting-IP）。
  if (!(await takeRateLimit(env.DB, 'introspect:global', 5000, 60))) {
    return bad('too many', 429)
  }
  if (!token) {
    return json({ active: false }, 401)
  }
  const session = await findSessionWithKey(env.DB, token)
  if (!session) {
    return json({ active: false }, 401)
  }
  // proxy 拿到这把 key 才能按用户转发聊天请求；明文只在这条带共享内部密钥的调用上下发，
  // 不经过浏览器，也不进任何响应缓存
  const secretEnv = env as Env & { KEY_ENC_SECRET?: string; UPSTREAM_USAGE_KEY?: string }
  let upstreamKey = ''
  if (session.keyEnc && secretEnv.KEY_ENC_SECRET) {
    upstreamKey = (await decryptSecret(session.keyEnc, secretEnv.KEY_ENC_SECRET)) ?? ''
  }
  // 解不出就返回空，绝不回落到 UPSTREAM_USAGE_KEY：那把是不限额的管理员 key，
  // 拿它当转发凭证等于给「注册成功但建 key 失败」的账号发一张无限额通行证。
  // 空值会让 proxy 走 verifyNoKey 回 403 no_key，前端提示额度未开通。
  return json({ active: true, user: session.user, expiresAt: session.expiresAt, upstreamKey })
}
