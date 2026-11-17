import { clearSessionCookie, currentUser, json, type Env } from '../../../server/auth-core.js'

/** POST /api/auth/logout：删掉本次会话并清 cookie */
export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const session = await currentUser(context.request, context.env.DB)
  if (session) {
    await context.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.tokenHash).run()
  }
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() })
}
