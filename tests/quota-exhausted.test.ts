import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

const { ApiError } = await import('../src/services/api/client')
const { classifyApiError, isRetryableApiError } = await import('../src/services/api/errors')

/**
 * 实测样本（2026-11-21，临时 key quota=1，打完一轮再打）：
 * HTTP 429，body 是 `{"error":{"message":"密钥配额已用尽","type":"insufficient_quota","code":"quota_exhausted"}}`。
 */
const upstreamQuotaError = () =>
  new ApiError('http', '密钥配额已用尽', 429, 'quota_exhausted')

describe('额度耗尽与限流要分开', () => {
  it('429 带 quota_exhausted 归为余额不足，且不重试', () => {
    const error = upstreamQuotaError()
    expect(classifyApiError(error)).toBe('insufficientBalance')
    expect(isRetryableApiError(error)).toBe(false)
  })

  it('只有文案没有 code 时也认得出来（老响应或别的上游）', () => {
    const error = new ApiError('http', '密钥配额已用尽', 429)
    expect(classifyApiError(error)).toBe('insufficientBalance')
  })

  it('普通 429 仍然算限流、仍然可重试', () => {
    const error = new ApiError('http', 'Rate limit reached', 429)
    expect(classifyApiError(error)).toBe('rateLimited')
    expect(isRetryableApiError(error)).toBe(true)
  })

  it('402 还是走原来的余额不足分支', () => {
    expect(classifyApiError(new ApiError('http', 'Insufficient Balance', 402))).toBe(
      'insufficientBalance'
    )
  })
})
