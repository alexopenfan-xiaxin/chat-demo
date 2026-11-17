/** 登录、注册与验证码相关接口，全部走同源 /api/auth/*。 */

export type AuthUser = { id: string; email: string }

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

export const login = async (email: string, password: string): Promise<AuthUser> =>
  (await post<{ user: AuthUser }>('login', { email, password })).user

export const register = async (
  email: string,
  code: string,
  password: string
): Promise<AuthUser> => (await post<{ user: AuthUser }>('register', { email, code, password })).user

export const logout = async (): Promise<void> => {
  await post('logout', {})
}

/** 请求注册验证码，turnstileToken 必须来自人机验证 */
export const requestCode = async (email: string, turnstileToken: string): Promise<void> => {
  await post('code', { email, turnstileToken })
}
