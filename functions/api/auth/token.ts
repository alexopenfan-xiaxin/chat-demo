import { ACCESS_TTL, currentUser, json, startSession, type Env } from '../../../server/auth-core'

/**
 * POST /api/auth/token：用 cookie 里的会话换一个给 api-ds-chat 用的 Bearer。
 * 页面刷新后内存里的 token 就没了，靠这条重新拿；cookie 仍然是 HttpOnly 那条路。
 */
export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const session = await currentUser(context.request, context.env.DB)
  if (!session) {
    return json({ error: '先登录' }, 401)
  }
  const token = await startSession(context.env.DB, session.user.id, context.request, ACCESS_TTL)
  return json({ token, expiresIn: ACCESS_TTL })
}
