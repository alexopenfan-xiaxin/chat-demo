import {
  MAX_PASSWORD, bad, clientIp, json, normalizeEmail, sessionCookie, startSession,
  takeRateLimit, verifyPassword, type Env,
} from '../../../server/auth-core'

/** 账号级失败次数上限与锁定时长（秒） */
const MAX_FAILURES = 5
const LOCK_SECONDS = 900

/** POST /api/auth/login：邮箱 + 密码登录，带失败次数锁定 */
export const onRequestPost = async (context: { request: Request; env: Env }) => {
  try {
    return await handle(context)
  } catch (error) {
    // 临时诊断：把真实异常带出来
    return new Response(JSON.stringify({ debug: String(error), stack: (error as Error)?.stack?.split('\n').slice(0, 4) }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
}

const handle = async (context: { request: Request; env: Env }) => {
  const { request, env } = context
  const ip = clientIp(request)
  let body: { email?: unknown; password?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return bad('请求格式不对')
  }
  const email = normalizeEmail(body.email)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!email || !password) {
    return bad('邮箱和密码都要填')
  }
  // 超长密码会把成本压到 PBKDF2 上，这里先拦掉
  if (password.length > MAX_PASSWORD) {
    return bad('邮箱或密码不对', 401)
  }
  if (!(await takeRateLimit(env.DB, `login:ip:${ip}`, 30, 600))) {
    return bad('尝试次数过多，十分钟后再试', 429)
  }
  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, failed_attempts, locked_until FROM users WHERE email = ?'
  )
    .bind(email)
    .first<{ id: string; email: string; password_hash: string; failed_attempts: number; locked_until: number }>()
  const now = Math.floor(Date.now() / 1000)
  // 邮箱不存在也走一遍哈希，避免用响应时间判断账号是否存在
  const stored = user?.password_hash ?? 'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
  const ok = await verifyPassword(password, stored)

  // 锁到期就把计数清零：否则只要再错一次就会重新锁满，攻击者每 15 分钟打 5 次
  // 就能把这个账号永久关在门外。
  let failures = user?.failed_attempts ?? 0
  let lockedUntil = user?.locked_until ?? 0
  if (user && lockedUntil > 0 && lockedUntil <= now) {
    failures = 0
    lockedUntil = 0
    await env.DB.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').bind(user.id).run()
  }

  if (!user || !ok) {
    if (user) {
      failures = Math.min(failures + 1, MAX_FAILURES * 4)
      // 锁定期内不再续期：否则每 15 分钟打错一次就能把账号永久锁死
      const lock = failures >= MAX_FAILURES && lockedUntil <= now ? now + LOCK_SECONDS : lockedUntil
      await env.DB.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
        .bind(failures, lock, user.id)
        .run()
    }
    return bad('邮箱或密码不对', 401)
  }
  if (lockedUntil > now) {
    return bad('密码错太多次，账号锁定中，过一会儿再试', 429)
  }
  await env.DB.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').bind(user.id).run()
  const token = await startSession(env.DB, user.id, request)
  // 明文 token 只在这一次响应里出现：前端放内存，给 api-ds-chat 的 proxy 验签用
  return json({ user: { id: user.id, email: user.email }, token }, 200, { 'set-cookie': sessionCookie(token) })
}
