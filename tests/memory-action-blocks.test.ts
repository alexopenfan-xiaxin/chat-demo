import { describe, expect, it } from 'vitest'

const { memoryActionBlocks, memoryFailureKey } = await import('../src/services/chat/toolBlocks')

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

  it('失败时只带固定 key，不把底层文案塞进去', () => {
    const blocks = memoryActionBlocks('call-2', 'edit', false, memoryFailureKey('没有这条记忆（爱吃芒果布丁）'))
    expect(blocks[0]).toMatchObject({ type: 'memory_action', count: 0, failureKey: 'memoryActionFailedMissing' })
    expect(JSON.stringify(blocks)).not.toContain('芒果布丁')
  })

  it('各类失败各归一类', () => {
    expect(memoryFailureKey('一条记忆最多 200 字')).toBe('memoryActionFailedTooLong')
    expect(memoryFailureKey('向量计算失败，这次没有改动')).toBe('memoryActionFailedEmbedding')
    expect(memoryFailureKey('没有找到明确对应的记忆，这 3 条最接近')).toBe('memoryActionFailedAmbiguous')
    expect(memoryFailureKey('已有一条相近的记忆 [m3]「x」')).toBe('memoryActionFailedConflict')
    expect(memoryFailureKey('内容为空，没有改动')).toBe('memoryActionFailedEmpty')
    expect(memoryFailureKey('某种没见过的错')).toBe('memoryActionFailedUnknown')
  })
})
