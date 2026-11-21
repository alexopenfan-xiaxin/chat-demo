import { describe, expect, it } from 'vitest'

const { readUsage } = await import('../src/services/api/responses')

/**
 * 真机上「已用 0 / 1M · 0%」「缓存命中率 —」的成因：
 * 真实的 response.completed 把 usage 放在 response 里面，我们以前只读事件顶层。
 */
describe('usage 读取', () => {
  it('读真实形状：usage 在 response 里', () => {
    const usage = readUsage({
      type: 'response.completed',
      sequence_number: 9,
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: {
          input_tokens: 18234,
          output_tokens: 512,
          total_tokens: 18746,
          input_tokens_details: { cached_tokens: 16000 },
        },
      },
    })
    expect(usage).toEqual({
      input_tokens: 18234,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 16000,
      output_tokens: 512,
    })
  })

  it('顶层形状仍然认（旧测试与本地桩用这种）', () => {
    const usage = readUsage({
      type: 'response.completed',
      usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } },
    })
    expect(usage?.input_tokens).toBe(100)
    expect(usage?.cache_read_input_tokens).toBe(40)
  })

  it('两层都没有时返回 undefined，不伪造 0', () => {
    expect(
      readUsage({ type: 'response.completed', response: { status: 'completed' } })
    ).toBeUndefined()
    expect(readUsage(null)).toBeUndefined()
  })

  it('response 里的 usage 缺字段时按 0 补齐', () => {
    const usage = readUsage({ response: { usage: { input_tokens: 10 } } })
    expect(usage).toEqual({
      input_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    })
  })
})
