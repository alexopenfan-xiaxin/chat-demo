import { describe, expect, it } from 'vitest'

const { memoryActionBlocks } = await import('../src/services/chat/toolBlocks')
const { MEMORY_REASON_KEYS } = await import('../src/services/memory/reasons')

/**
 * 失败原因只能是本地固定文案：底层 message 里可能带出相近条目的正文，
 * 所以这里只允许映射到几个固定 key，绝不能把原文拼进界面。
 */
describe('记忆动作记录', () => {
  it('成功时只报动作与条数，不带任何内容', () => {
    const blocks = memoryActionBlocks('call-1', 'save', true)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'memory_action', action: 'save', count: 1 })
    expect(JSON.stringify(blocks)).not.toContain('content')
  })

  it('失败时只带枚举，块里不可能出现正文', () => {
    const blocks = memoryActionBlocks('call-2', 'edit', false, 'not_found')
    expect(blocks[0]).toMatchObject({ type: 'memory_action', count: 0, failureReason: 'not_found' })
    expect(JSON.stringify(blocks)).not.toContain('content')
    expect(JSON.stringify(blocks)).not.toContain('message')
  })

  it('枚举到文案是一一对应的，未知值有兜底', () => {
    expect(MEMORY_REASON_KEYS.too_long).toBe('memoryActionFailedTooLong')
    expect(MEMORY_REASON_KEYS.embed_failed).toBe('memoryActionFailedEmbedding')
    expect(MEMORY_REASON_KEYS.ambiguous).toBe('memoryActionFailedAmbiguous')
    expect(MEMORY_REASON_KEYS.too_close).toBe('memoryActionFailedConflict')
    expect(MEMORY_REASON_KEYS.empty).toBe('memoryActionFailedEmpty')
    expect(MEMORY_REASON_KEYS.not_found).toBe('memoryActionFailedMissing')
    expect(MEMORY_REASON_KEYS.not_configured).toBe('memoryActionFailedUnavailable')
  })
})
