import {
  guarded, MAX_PASSWORD, bad, clientIp, currentUser, hashPassword, json, passwordProblem,
  pbkdf2Iterations, verifyPassword, takeRateLimit, type Env,
} from '../../../server/auth-core'

/**
 * POST /api/auth/password：已登录用户改密码。
 *
 * 一定要验当前密码：会话 cookie 可能是别人临时用过的机器，只凭会话就能改密码
 * 等于把「拿到 30 天 cookie」升级成「永久占有账号」。
 * 改完把**其它**会话全部吊销，当前这条留着，免得用户刚落笔就被踢下线。
 */
export const onRequestPost = guarded(async (context: { request: Request; env: Env }) => {
  const { request, env } = context
  const session = await currentUser(request, env.DB)
  if (!session) {
    return bad('先登录', 401)
  }
  let body: { currentPassword?: unknown; newPassword?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return bad('请求格式不对')
  }
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
  if (!currentPassword) {
    return bad('请填当前密码')
  }
  if (currentPassword.length > MAX_PASSWORD) {
    return bad('当前密码不对', 401)
  }
  const problem = passwordProblem(newPassword)
  if (problem) {
    return bad(problem)
  }
  if (currentPassword === newPassword) {
    return bad('新密码和当前密码一样')
  }
  const ip = clientIp(request)
  if (!(await takeRateLimit(env.DB, `password:ip:${ip}`, 20, 3600))) {
    return bad('尝试次数过多，过一会儿再试', 429)
  }
  // 按账号再限一道：换 IP 也拿不到无限次「验当前密码」的机会
  if (!(await takeRateLimit(env.DB, `password:user:${session.user.id}`, 10, 3600))) {
    return bad('改密码太频繁，过一会儿再试', 429)
  }
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(session.user.id)
    .first<{ password_hash: string }>()
  if (!row) {
    return bad('先登录', 401)
  }
  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    return bad('当前密码不对', 401)
  }
  const passwordHash = await hashPassword(newPassword, pbkdf2Iterations(env))
  await env.DB.prepare(
    'UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?'
  )
    .bind(passwordHash, session.user.id)
    .run()
  // 吊销其它设备上的会话：密码换了，之前发出去的 cookie 就不该再能用
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
    .bind(session.user.id, session.tokenHash)
    .run()
  // 生效时间必须由服务端给：前端 new Date() 在别的时区会显示成另一个时间
  return json({ ok: true, updatedAt: new Date().toISOString() })
})
