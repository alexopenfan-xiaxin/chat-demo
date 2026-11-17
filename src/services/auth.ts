/** 登录、注册与验证码相关接口，全部走同源 /api/auth/*。 */

export type AuthUser = { id: string; email: string }

/**
 * 给 api-ds-chat 的 proxy 用的会话票。只放内存，不落 localStorage：
 * 刷新页面后由 ensureAccessToken 拿 cookie 换一张新的。
 */
let accessToken: string | null = null
let tokenRequest: Promise<string | null> | null = null
const sessionExpiredListeners = new Set<() => void>()

export const getAccessToken = (): string | null => accessToken

export const clearAccessToken = () => {
  accessToken = null
}

/** 会话过期的通知：请求层判断 401 属于 proxy 时调用，界面据此显示横幅 */
export const onSessionExpired = (listener: () => void) => {
  sessionExpiredListeners.add(listener)
  return () => {
    sessionExpiredListeners.delete(listener)
  }
}

export const notifySessionExpired = () => {
  clearAccessToken()
  for (const listener of sessionExpiredListeners) {
    listener()
  }
}

/**
 * 懒获取 + single-flight：并发六个流时只会打一次 /api/auth/token，
 * 大家共享同一个 Promise。
 */
export const ensureAccessToken = (): Promise<string | null> => {
  if (accessToken !== null) {
    return Promise.resolve(accessToken)
  }
  if (tokenRequest === null) {
    tokenRequest = post<{ token: string }>('token', {})
      .then((data) => {
        accessToken = data.token
        return data.token
      })
      .catch(() => null)
      .finally(() => {
        tokenRequest = null
      })
  }
  return tokenRequest
}

/** 带上 HTTP 状态码，界面按状态决定错误落在哪个字段（见规范 §12） */
export class AuthError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

const post = async <T>(path: string, body: unknown): Promise<T> => {
  let response: Response
  try {
    response = await fetch(`/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    })
  } catch {
    throw new AuthError('网络好像不太顺，再试一次', 0)
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string } & T
  if (!response.ok) {
    throw new AuthError(data.error ?? `请求失败（${response.status}）`, response.status)
  }
  return data
}

/** 当前登录用户；未登录返回 null */
export const fetchMe = async (): Promise<AuthUser | null> => {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' })
    if (!response.ok) {
      return null
    }
    const data = (await response.json()) as { user: AuthUser | null }
    return data.user ?? null
  } catch {
    return null
  }
}

const acceptSession = (data: { user: AuthUser; token?: string }): AuthUser => {
  accessToken = data.token ?? null
  return data.user
}

export const login = async (email: string, password: string): Promise<AuthUser> =>
  acceptSession(await post<{ user: AuthUser; token: string }>('login', { email, password }))

export const register = async (
  email: string,
  code: string,
  password: string
): Promise<AuthUser> =>
  acceptSession(await post<{ user: AuthUser; token: string }>('register', { email, code, password }))

export const logout = async (): Promise<void> => {
  try {
    await post('logout', {})
  } finally {
    // 退出后这张票立刻丢掉：即使 proxy 的 60 秒缓存还没过期，前端也不会再用它
    accessToken = null
  }
}

/** 请求注册验证码，turnstileToken 必须来自人机验证 */
export const requestCode = async (email: string, turnstileToken: string): Promise<void> => {
  await post('code', { email, turnstileToken })
}
