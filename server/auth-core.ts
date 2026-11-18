/**
 * 登录与注册的共用逻辑，供 functions/api/auth/* 复用。
 * 密码用 PBKDF2-SHA256 存哈希，会话只存 token 的 SHA-256，验证码只存哈希。
 */

export type Env = {
  DB: D1Database
  TURNSTILE_SECRET: string
  MAIL_RELAY_URL: string
  MAIL_RELAY_TOKEN: string
  /** 可选：覆盖建哈希用的 PBKDF2 迭代次数，Workers 的 CPU 限额各档不同 */
  PBKDF2_ITERATIONS?: string
  /** proxy 调 introspect 时带的共享密钥，没配就一律拒绝 */
  INTERNAL_API_SECRET?: string
}

/** Cloudflare 的 D1 类型只做最小声明，避免引入额外依赖 */
export type D1Database = {
  prepare: (sql: string) => {
    bind: (...values: unknown[]) => {
      first: <T = Record<string, unknown>>() => Promise<T | null>
      run: () => Promise<{ success: boolean }>
      all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>
    }
    first: <T = Record<string, unknown>>() => Promise<T | null>
    run: () => Promise<{ success: boolean }>
  }
}

/**
 * __Host- 前缀让浏览器强制这条 cookie 只能是 Secure、Path=/、不带 Domain 的，
 * 别的子域写不进来，也挡掉用同名 cookie 做会话固定的路子。
 */
export const SESSION_COOKIE = '__Host-ds_chat_session'
export const SESSION_TTL = 30 * 24 * 3600
/** 内存里的 Bearer 会话短一些：刷新页面就用 cookie 换新的 */
export const ACCESS_TTL = 12 * 3600
/** proxy 调 introspect 的共享头，避免这个接口变成公开的会话探测点 */
export const INTERNAL_HEADER = 'x-ds-chat-internal'
export const CODE_TTL = 10 * 60
export const MAX_CODE_ATTEMPTS = 5

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })

export const bad = (message: string, status = 400) => json({ error: message }, status)

const enc = new TextEncoder()

export const b64 = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ''
  for (const byte of view) {
    out += String.fromCharCode(byte)
  }
  return btoa(out)
}

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const randomToken = (bytes = 32): string => {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 新哈希的迭代次数。**workerd 硬上限是 100000**：超过就抛
 * NotSupportedError("Pbkdf2 failed: iteration counts above 100000 are not supported")，
 * 所以 210000 在这套运行时里根本跑不起来（实测 100k≈19ms CPU）。默认取上限，
 * 校验一律读哈希里存的次数，老记录不受影响。
 */
const DEFAULT_PBKDF2_ITERATIONS = 100000
const MIN_PBKDF2_ITERATIONS = 50000
/** 运行时上限，不能更大 */
const MAX_PBKDF2_ITERATIONS = 100000

export const pbkdf2Iterations = (env: Env): number => {
  const value = Number(env.PBKDF2_ITERATIONS)
  if (!Number.isInteger(value) || value < MIN_PBKDF2_ITERATIONS || value > MAX_PBKDF2_ITERATIONS) {
    return DEFAULT_PBKDF2_ITERATIONS
  }
  return value
}

/** 存成 pbkdf2$迭代次数$盐$哈希，便于以后调参 */
export const hashPassword = async (password: string, iterations = DEFAULT_PBKDF2_ITERATIONS): Promise<string> => {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  )
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`
}

/** 迭代次数只接受合理区间：数据库里被改坏的记录不该变成一次 CPU 炸弹；上限受 Workers 限制 */
const MIN_ITERATIONS = 1000
const MAX_ITERATIONS = 100000

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') {
    return false
  }
  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    return false
  }
  let salt: Uint8Array<ArrayBuffer>
  // 比较的是 base64 文本本身：atob 出来的是二进制串，和 b64(bits) 长度都不一样
  const expected = parts[3]
  try {
    salt = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0))
    if (atob(expected).length === 0) {
      return false
    }
  } catch {
    return false
  }
  if (salt.length === 0) {
    return false
  }
  try {
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      256
    )
    return safeEqual(b64(bits), expected)
  } catch {
    // 超上限、参数损坏之类：当作验证不通过，别让登录 500
    return false
  }
}

/** 定长比较，避免时间侧信道；长度不同也走一遍循环再返回 */
export const safeEqual = (actual: string, expected: string): boolean => {
  let diff = actual.length ^ expected.length
  const length = Math.max(actual.length, expected.length)
  for (let i = 0; i < length; i += 1) {
    diff |= (actual.charCodeAt(i) | 0) ^ (expected.charCodeAt(i) | 0)
  }
  return diff === 0
}

export const MIN_PASSWORD = 8
/** 上限：PBKDF2 的成本随密码长度上升，没有上限就是一个廉价的 CPU 消耗点 */
export const MAX_PASSWORD = 200

/** 密码规则只在注册时用；返回给用户的中文提示，或 null 表示通过 */
export const passwordProblem = (password: string): string | null => {
  if (password.length < MIN_PASSWORD) {
    return `密码至少 ${MIN_PASSWORD} 位`
  }
  if (password.length > MAX_PASSWORD) {
    return `密码最多 ${MAX_PASSWORD} 位`
  }
  return null
}

export const normalizeEmail = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const email = value.trim().toLowerCase()
  if (email.length < 5 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return null
  }
  return email
}

/** 简单的计数型限流：窗口内超过上限即拒绝 */
/**
 * 计数型限流，一条语句完成读-改-写：先 SELECT 再 UPDATE 会让并发请求读到同一个计数
 * 然后一起放行。RETURNING 拿到自增后的值，再判断是否超限。
 */
export const takeRateLimit = async (
  db: D1Database,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> => {
  const now = Math.floor(Date.now() / 1000)
  const resetAt = now + windowSeconds
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END
       RETURNING count`
    )
    .bind(key, resetAt, now, now, resetAt)
    .first<{ count: number }>()
  if (row !== null && row.count === 1) {
    // 新窗口的第一次写入顺手清掉过期计数，表不会无限长；频率与请求量同阶，不用定时任务
    await db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(now).run()
  }
  return row !== null && row.count <= limit
}

/**
 * 只读预检：这个桶是否已经用满，不写库。
 *
 * 给「先问还能不能做，做成之后才计数」的场景用。takeRateLimit 是写在前面的，
 * 上游失败也会扣掉一次，用户重试几次额度就没了。
 *
 * 预检和记账之间不是原子的：并发突发时多个请求会同时通过预检、之后各记一次，
 * 这一瞬间能超过上限。所以 60/小时 是软上限，只防正常使用的暴搜和误用，
 * 不是精确配额——别拿这个数字做容量估算。
 */
export const rateLimitReached = async (
  db: D1Database,
  key: string,
  limit: number
): Promise<boolean> => {
  const row = await db
    .prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?')
    .bind(key)
    .first<{ count: number; reset_at: number }>()
  if (row === null) {
    return false
  }
  if (row.reset_at <= Math.floor(Date.now() / 1000)) {
    return false
  }
  return row.count >= limit
}

/**
 * 只信 Cloudflare 注入的 cf-connecting-ip。x-real-ip / x-forwarded-for 都是调用方
 * 可以自己写的，取了就等于把限流键交给攻击者。
 */
export const clientIp = (request: Request): string =>
  request.headers.get('cf-connecting-ip') ?? 'unknown'

export const verifyTurnstile = async (
  env: Env,
  token: unknown,
  ip: string
): Promise<boolean> => {
  if (typeof token !== 'string' || token.length === 0) {
    return false
  }
  const body = new FormData()
  body.append('secret', env.TURNSTILE_SECRET)
  body.append('response', token)
  if (ip !== 'unknown') {
    body.append('remoteip', ip)
  }
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5000),
    })
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch {
    return false
  }
}

export const sendMail = async (env: Env, to: string, subject: string, text: string) => {
  const res = await fetch(env.MAIL_RELAY_URL.replace(/\/+$/, '') + '/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-token': env.MAIL_RELAY_TOKEN },
    body: JSON.stringify({ to, subject, text }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    throw new Error(`发信失败：${res.status}`)
  }
}

export const sessionCookie = (token: string): string =>
  `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`

export const clearSessionCookie = (): string =>
  `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`

export const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get('cookie')
  if (!header) {
    return null
  }
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) {
      return rest.join('=')
    }
  }
  return null
}

export type SessionUser = { id: string; email: string }

/** 建一条会话并返回明文 token；cookie 与 Bearer 用的是同一种记录 */
export const startSession = async (
  db: D1Database,
  userId: string,
  request: Request,
  ttl = SESSION_TTL
): Promise<string> => {
  const token = randomToken()
  const now = Math.floor(Date.now() / 1000)
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ua, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now, now + ttl, request.headers.get('user-agent') ?? '', clientIp(request))
    .run()
  return token
}

/** 按明文 token 查会话；过期即删，返回 null */
export const findSession = async (
  db: D1Database,
  token: string
): Promise<{ user: SessionUser; expiresAt: number } | null> => {
  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare(
      'SELECT s.expires_at AS expires_at, u.id AS id, u.email AS email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
    )
    .bind(tokenHash)
    .first<{ expires_at: number; id: string; email: string }>()
  if (!row) {
    return null
  }
  if (row.expires_at <= Math.floor(Date.now() / 1000)) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
    return null
  }
  return { user: { id: row.id, email: row.email }, expiresAt: row.expires_at }
}

/**
 * 会话 + 该用户的 key 密文一次查完。
 *
 * introspect 每次请求都要这两样，拆成两次查询等于每个冷启动多付一轮 D1 往返。
 */
export const findSessionWithKey = async (
  db: D1Database,
  token: string
): Promise<{ user: SessionUser; expiresAt: number; keyEnc: string | null } | null> => {
  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare(
      'SELECT s.expires_at AS expires_at, u.id AS id, u.email AS email, u.upstream_key_enc AS key_enc FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
    )
    .bind(tokenHash)
    .first<{ expires_at: number; id: string; email: string; key_enc: string | null }>()
  if (!row) {
    return null
  }
  if (row.expires_at <= Math.floor(Date.now() / 1000)) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
    return null
  }
  return { user: { id: row.id, email: row.email }, expiresAt: row.expires_at, keyEnc: row.key_enc }
}

/** 从 Authorization 头取 Bearer 明文，格式不对返回 null */
export const bearerToken = (request: Request): string | null => {
  const header = request.headers.get('authorization')
  if (!header) {
    return null
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : null
}

/** 校验会话并返回用户；失效时同时清掉记录 */
export const currentUser = async (
  request: Request,
  db: D1Database
): Promise<{ user: SessionUser; tokenHash: string } | null> => {
  const token = readCookie(request, SESSION_COOKIE)
  if (!token) {
    return null
  }
  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare(
      'SELECT s.expires_at AS expires_at, u.id AS id, u.email AS email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
    )
    .bind(tokenHash)
    .first<{ expires_at: number; id: string; email: string }>()
  if (!row) {
    return null
  }
  if (row.expires_at <= Math.floor(Date.now() / 1000)) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
    return null
  }
  return { user: { id: row.id, email: row.email }, tokenHash }
}

/**
 * 兜底：没人想看到 Cloudflare 的 1101 裸奔。未预期异常记一条日志，回一个通用 500，
 * 调用方拿到的是人话，日志里拿到的是栈。
 */
export const guarded = (
  handler: (context: { request: Request; env: Env }) => Promise<Response>
) => async (context: { request: Request; env: Env }): Promise<Response> => {
  try {
    return await handler(context)
  } catch (error) {
    // Workers 的日志只能走 console；这条是运维需要的，不是调试残留
    // eslint-disable-next-line no-console
    console.error('auth handler failed', context.request.url, error)
    return json({ error: '服务器出了点问题，稍后再试' }, 500)
  }
}
