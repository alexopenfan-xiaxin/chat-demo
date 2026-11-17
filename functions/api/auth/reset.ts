import {
  guarded, MAX_CODE_ATTEMPTS, bad, clientIp, hashPassword, json, normalizeEmail, passwordProblem,
  pbkdf2Iterations, safeEqual, sha256Hex, takeRateLimit, type Env,
} from '../../../server/auth-core'

/**
 * POST /api/auth/reset：邮箱验证码重置密码（忘记密码）。
 *
 * 这条是「谁都登不进去」时的唯一出口，所以不需要会话，靠邮箱验证码证明身份。
 * 重置成功后**吊销该用户全部会话**，并且不直接发新会话——让用户拿新密码重新登录，
 * 万一邮箱本身被动过，攻击者也拿不到一条现成的登录态。
 */
export const onRequestPost = guarded(async (context: { request: Request; env: Env }) => {
  const { request, env } = context
  let body: { email?: unknown; code?: unknown; password?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return bad('请求格式不对')
  }
  const email = normalizeEmail(body.email)
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!email) {
    return bad('邮箱格式不对')
  }
  if (!/^\d{6}$/.test(code)) {
    return bad('验证码是 6 位数字')
  }
  const problem = passwordProblem(password)
  if (problem) {
    return bad(problem)
  }
  // 放在 PBKDF2 之前：错误验证码不该能把 CPU 烧起来
  if (!(await takeRateLimit(env.DB, `reset:ip:${clientIp(request)}`, 20, 3600))) {
    return bad('这个网络地址重置太频繁，过一会儿再试', 429)
  }
  const row = await env.DB.prepare(
    'SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ? AND purpose = ?'
  )
    .bind(email, 'reset')
    .first<{ code_hash: string; expires_at: number; attempts: number }>()
  // 没申请过验证码也回同一句话：别用这里区分「这个邮箱存不存在」
  if (!row) {
    return bad('验证码不对或已过期', 400)
  }
  const now = Math.floor(Date.now() / 1000)
  if (row.expires_at <= now) {
    return bad('验证码过期了，重新获取', 400)
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    return bad('验证码错误次数太多，重新获取', 429)
  }
  if (!safeEqual(await sha256Hex(`${email}:${code}`), row.code_hash)) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?')
      .bind(email, 'reset')
      .run()
    return bad('验证码不对', 400)
  }
  // 原子消费：并发送同一个有效码时只有第一个能删到行
  const consumed = await env.DB.prepare(
    'DELETE FROM email_codes WHERE email = ? AND purpose = ? AND code_hash = ? RETURNING email'
  )
    .bind(email, 'reset', row.code_hash)
    .first<{ email: string }>()
  if (!consumed) {
    return bad('验证码已经用过了，重新获取', 409)
  }
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>()
  if (!user) {
    return bad('验证码不对或已过期', 400)
  }
  const passwordHash = await hashPassword(password, pbkdf2Iterations(env))
  await env.DB.prepare(
    'UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?'
  )
    .bind(passwordHash, user.id)
    .run()
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run()
  return json({ ok: true, updatedAt: new Date().toISOString() })
})
