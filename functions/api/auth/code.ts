import {
  CODE_TTL, bad, clientIp, json, normalizeEmail, sendMail, sha256Hex, takeRateLimit,
  verifyTurnstile, type Env,
} from '../../../server/auth-core'

/** POST /api/auth/code：校验人机验证后，把注册验证码发到邮箱 */
export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const { request, env } = context
  const ip = clientIp(request)
  let body: { email?: unknown; turnstileToken?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return bad('请求格式不对')
  }
  const email = normalizeEmail(body.email)
  if (!email) {
    return bad('邮箱格式不对')
  }
  // 便宜的本地计数放在最前面：伪造的 token 每次都要打一次外部 siteverify，
  // 顺序反过来就等于拿我们当人机验证的放大器，5 秒超时还会拖住 Worker。
  if (!(await takeRateLimit(env.DB, `code:ip:${ip}`, 20, 3600))) {
    return bad('这个网络地址一小时内请求太多，过一会儿再试', 429)
  }
  if (!(await verifyTurnstile(env, body.turnstileToken, ip))) {
    return bad('人机验证没通过，刷新后重试', 403)
  }
  if (!(await takeRateLimit(env.DB, `code:gap:${email}`, 1, 60))) {
    return bad('验证码刚发过，等一分钟再试', 429)
  }
  // 单个来源对一个邮箱的配额：不让一个 IP 把受害者的邮箱配额 5 次打光
  if (!(await takeRateLimit(env.DB, `code:email-ip:${email}:${ip}`, 3, 3600))) {
    return bad('这个网络地址给该邮箱发得太频繁，过一会儿再试', 429)
  }
  if (!(await takeRateLimit(env.DB, `code:email:${email}`, 10, 3600))) {
    return bad('该邮箱一小时内收到的验证码太多，过一会儿再试', 429)
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (existing) {
    // 已注册也返回同样的成功形状：否则拿一个 Turnstile 令牌就能批量探测邮箱是否注册过。
    // 这封信只是一个提示，不产生验证码记录。
    try {
      await sendMail(
        env,
        email,
        'ds-chat 账号已存在',
        '这个邮箱已经注册过 ds-chat，直接去登录就行。\n\n如果不是你本人操作，忽略这封邮件即可。\n'
      )
    } catch {
      // 这里的失败不影响调用方看到的结果
    }
    return json({ ok: true, ttl: CODE_TTL })
  }

  const buffer = new Uint32Array(1)
  crypto.getRandomValues(buffer)
  const code = String(100000 + (buffer[0] % 900000))
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO email_codes (email, purpose, code_hash, created_at, expires_at, attempts, ip)
     VALUES (?, 'register', ?, ?, ?, 0, ?)
     ON CONFLICT(email, purpose) DO UPDATE SET code_hash = excluded.code_hash,
       created_at = excluded.created_at, expires_at = excluded.expires_at, attempts = 0, ip = excluded.ip`
  )
    .bind(email, await sha256Hex(`${email}:${code}`), now, now + CODE_TTL, ip)
    .run()
  try {
    await sendMail(
      env,
      email,
      'ds-chat 注册验证码',
      `你的注册验证码是 ${code}\n\n十分钟内有效。如果不是你本人操作，忽略这封邮件即可。\n`
    )
  } catch {
    return bad('验证码发出去了但邮件没送到，稍后重试', 502)
  }
  return json({ ok: true, ttl: CODE_TTL })
}
