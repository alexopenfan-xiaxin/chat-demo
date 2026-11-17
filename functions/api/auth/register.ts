import {
  MAX_CODE_ATTEMPTS, bad, clientIp, hashPassword, json, normalizeEmail, passwordProblem,
  pbkdf2Iterations, safeEqual, sessionCookie, sha256Hex, startSession, takeRateLimit, type Env,
} from '../../../server/auth-core'

/** POST /api/auth/register：用邮箱验证码 + 密码建号，直接登录 */
export const onRequestPost = async (context: { request: Request; env: Env }) => {
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
  // 放在最贵的 PBKDF2 之前：否则错误验证码也能拿来烧 CPU
  if (!(await takeRateLimit(env.DB, `register:ip:${clientIp(request)}`, 20, 3600))) {
    return bad('这个网络地址注册太频繁，过一会儿再试', 429)
  }
  const row = await env.DB.prepare(
    'SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ? AND purpose = ?'
  )
    .bind(email, 'register')
    .first<{ code_hash: string; expires_at: number; attempts: number }>()
  if (!row) {
    return bad('先获取验证码')
  }
  const now = Math.floor(Date.now() / 1000)
  if (row.expires_at <= now) {
    return bad('验证码过期了，重新获取')
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    return bad('验证码错误次数太多，重新获取', 429)
  }
  if (!safeEqual(await sha256Hex(`${email}:${code}`), row.code_hash)) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?')
      .bind(email, 'register')
      .run()
    return bad('验证码不对', 400)
  }
  // 原子消费：并发打同一个有效码，只有第一个 DELETE 能拿到行，后面的直接 409，
  // 不会变成 N 次 PBKDF2。
  const consumed = await env.DB.prepare(
    'DELETE FROM email_codes WHERE email = ? AND purpose = ? AND code_hash = ? RETURNING email'
  )
    .bind(email, 'register', row.code_hash)
    .first<{ email: string }>()
  if (!consumed) {
    return bad('验证码已经用过了，重新获取', 409)
  }
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (existing) {
    return bad('这个邮箱已经注册过了，直接登录就行', 409)
  }
  const id = crypto.randomUUID()
  const passwordHash = await hashPassword(password, pbkdf2Iterations(env))
  try {
    await env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, created_at, email_verified, failed_attempts, locked_until) VALUES (?, ?, ?, ?, 1, 0, 0)'
    )
      .bind(id, email, passwordHash, now)
      .run()
  } catch (error) {
    // users.email 有 UNIQUE：并发两个请求都能通过上面的存在性检查，让后到的那一个
    // 得到和先到的一样的回答，而不是一个 500。
    const message = error instanceof Error ? error.message : ''
    if (message.includes('UNIQUE') || message.includes('unique')) {
      return bad('这个邮箱已经注册过了，直接登录就行', 409)
    }
    throw error
  }
  const token = await startSession(env.DB, id, request)
  return json({ user: { id, email }, token }, 200, { 'set-cookie': sessionCookie(token) })
}
