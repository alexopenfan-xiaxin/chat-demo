import { currentUser, json, type Env } from '../../../server/auth-core.js'

/** GET /api/auth/me：当前登录用户 */
export const onRequestGet = async (context: { request: Request; env: Env }) => {
  const session = await currentUser(context.request, context.env.DB)
  if (!session) {
    return json({ user: null }, 401)
  }
  return json({ user: session.user })
}
