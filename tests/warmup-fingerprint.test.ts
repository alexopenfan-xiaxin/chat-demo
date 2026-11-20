import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

const { tokenFingerprint } = await import('../src/services/memory/api')

/**
 * 预热标记的键：换票后指纹必须变（否则换票那一轮召回还要付一次验票），
 * 同一张票必须稳定（否则每次渲染都重复预热）。
 */
describe('tokenFingerprint', () => {
  it('同一张票稳定，不同票不同', async () => {
    const a = await tokenFingerprint('token-aaa')
    const again = await tokenFingerprint('token-aaa')
    const b = await tokenFingerprint('token-bbb')
    expect(a).toBe(again)
    expect(a).not.toBe(b)
  })

  it('只给 8 个十六进制字符，不泄漏原票', async () => {
    const token = 'relaybenchA0123456789abcdef0123456789abcdef'
    const fingerprint = await tokenFingerprint(token)
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(fingerprint).not.toContain(token.slice(0, 8))
  })
})
