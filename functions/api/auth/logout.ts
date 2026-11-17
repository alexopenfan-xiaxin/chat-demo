import { bearerToken, clearSessionCookie, currentUser, json, sha256Hex, type Env } from '../../../server/auth-core.js'

/** POST /api/auth/logout：删掉本次会话并清 cookie */
export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const session = await currentUser(context.request, context.env.DB)
  if (session) {
    await context.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.tokenHash).run()
  }
  // 页面刷新后 cookie 换来的 Bearer 是另一条会话记录，一起删掉，别让它活过退出
  const bearer = bearerToken(context.request)
  if (bearer) {
    await context.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(bearer)).run()
  }
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() })
}
