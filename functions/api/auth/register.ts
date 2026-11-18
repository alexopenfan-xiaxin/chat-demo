import {
  guarded, MAX_CODE_ATTEMPTS, bad, clientIp, hashPassword, json, normalizeEmail, passwordProblem,
  pbkdf2Iterations, safeEqual, sessionCookie, sha256Hex, startSession, takeRateLimit, type Env,
} from '../../../server/auth-core'
import { encryptSecret } from '../../../server/keybox'
import { createUpstreamKey, deletePanelKey } from '../../../server/panel'

/** POST /api/auth/register：用邮箱验证码 + 密码建号，直接登录 */
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

  // 建 key 走 proxy 的内部密钥通道，不需要用户会话（注册这一刻还没有会话）
  const keyEnv = env as Env & {
    INTERNAL_API_SECRET?: string
    PANEL_KEY_IP_ALLOWLIST?: string
    UPSTREAM_BASE?: string
    PANEL_ADMIN_USER?: string
    PANEL_ADMIN_PASSWORD?: string
    KEY_ENC_SECRET?: string
  }
  const encSecret = keyEnv.KEY_ENC_SECRET
  if (!encSecret) {
    return bad('注册暂时不可用，稍后再试', 503)
  }
  // 建这把用户的 key：失败就不建号，免得出一个没有额度、聊不了天的账号
  const created = await createUpstreamKey(keyEnv, email)
  if (!created) {
    return bad('开通额度失败，稍后再试', 503)
  }
  const encrypted = await encryptSecret(created.key, encSecret)
  try {
    await env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, created_at, email_verified, failed_attempts, locked_until, upstream_key_enc, upstream_key_name, upstream_key_prefix, upstream_key_quota) VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?)'
    )
      .bind(id, email, passwordHash, now, encrypted, created.name, created.key.slice(0, 11), created.quota)
      .run()
  } catch (error) {
    // 写库失败就把刚建的 key 删掉：否则面板上留一把孤儿 key，而 key 名是按邮箱
    // 确定性生成的，下次同一个邮箱再注册会撞到它、又拿不到明文，等于永久注册不进去。
    await deletePanelKey(keyEnv, created.id)
    // users.email 有 UNIQUE：并发两个请求都能通过上面的存在性检查，让后到的那一个
    // 得到和先到的一样的回答，而不是一个 500。
    const message = error instanceof Error ? error.message : ''
    if (message.includes('UNIQUE') || message.includes('unique')) {
      return bad('这个邮箱已经注册过了，直接登录就行', 409)
    }
    throw error
  }
  // 账已经建好，这时候才签会话：建 key 失败不会留下一条孤儿会话
  const token = await startSession(env.DB, id, request)
  return json({ user: { id, email }, token }, 200, { 'set-cookie': sessionCookie(token) })
})
