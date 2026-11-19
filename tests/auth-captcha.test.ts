import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyCaptcha, type Env } from '../server/auth-core'

/**
 * 人机验证的选路口径：provider 决定打哪一家的 siteverify，任何异常态都必须判失败。
 * 这里只验决策，不打真实网络——fetch 全是桩。
 */
const env = (overrides: Partial<Env> = {}): Env =>
  ({
    DB: {} as never,
    TURNSTILE_SECRET: 'turnstile-secret',
    HCAPTCHA_SECRET: 'hcaptcha-secret',
    MAIL_RELAY_URL: 'https://relay.invalid',
    MAIL_RELAY_TOKEN: 'token',
    ...overrides,
  }) as Env

const okFetch = (success: boolean) =>
  vi.fn(async () => new Response(JSON.stringify({ success }), { status: 200 }))

const urls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((call) => String(call[0]))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('verifyCaptcha', () => {
  it('没带 provider 时按 Turnstile 验（兼容缓存下来的旧 bundle）', async () => {
    const fetchMock = okFetch(true)
    vi.stubGlobal('fetch', fetchMock)
    await expect(verifyCaptcha(env(), undefined, 'tok', '1.2.3.4')).resolves.toBe(true)
    expect(urls(fetchMock)).toEqual(['https://challenges.cloudflare.com/turnstile/v0/siteverify'])
  })

  it('声明 hcaptcha 时打 hCaptcha 的 siteverify，并带上密钥', async () => {
    const fetchMock = okFetch(true)
    vi.stubGlobal('fetch', fetchMock)
    await expect(verifyCaptcha(env(), 'hcaptcha', 'tok', '1.2.3.4')).resolves.toBe(true)
    expect(urls(fetchMock)).toEqual(['https://api.hcaptcha.com/siteverify'])
    const body = String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)
    expect(body).toContain('secret=hcaptcha-secret')
    expect(body).toContain('response=tok')
  })

  it('hCaptcha 回 success:false 时判失败', async () => {
    vi.stubGlobal('fetch', okFetch(false))
    await expect(verifyCaptcha(env(), 'hcaptcha', 'tok', '1.2.3.4')).resolves.toBe(false)
  })

  it('hCaptcha 没配密钥时直接失败，不发请求也不放行', async () => {
    const fetchMock = okFetch(true)
    vi.stubGlobal('fetch', fetchMock)
    await expect(verifyCaptcha(env({ HCAPTCHA_SECRET: undefined }), 'hcaptcha', 'tok', '1.2.3.4')).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('非法 provider 一律失败，不默认落到任何一边', async () => {
    const fetchMock = okFetch(true)
    vi.stubGlobal('fetch', fetchMock)
    for (const value of ['recaptcha', 'Hcaptcha', '', 1, null, {}]) {
      await expect(verifyCaptcha(env(), value, 'tok', '1.2.3.4')).resolves.toBe(false)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('token 为空或不是字符串时失败，且不发请求', async () => {
    const fetchMock = okFetch(true)
    vi.stubGlobal('fetch', fetchMock)
    for (const token of ['', '   ', undefined, null, 42]) {
      await expect(verifyCaptcha(env(), 'turnstile', token, '1.2.3.4')).resolves.toBe(false)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('验证服务抛错（网络失败）时判失败', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )
    await expect(verifyCaptcha(env(), 'hcaptcha', 'tok', '1.2.3.4')).resolves.toBe(false)
  })
})
