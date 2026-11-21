import { describe, expect, it } from 'vitest'

const { buildReplyView } = await import('../src/services/chat/view')

const reply = (blocks: unknown[]) => ({ blocks }) as never

/**
 * 记忆工具动作以前渲染在正文下面，现在和搜索、读取一样是「过程中的一步」：
 * 位置必须就是调用位置，夹在两段思考之间时不能被挪到最后。
 */
describe('记忆动作在思考过程里的位置', () => {
  it('按 blocks 里的位置插到对应思考段之后', () => {
    const view = buildReplyView(
      reply([
        { type: 'thinking', thinking: '先想想' },
        { type: 'memory_action', id: 'memory-call-1', action: 'save', count: 1 },
        { type: 'thinking', thinking: '再想想' },
        { type: 'text', text: '答案' },
      ]),
      false
    )
    expect(view.steps.map((step) => step.type)).toEqual(['thinking', 'memory', 'thinking'])
    expect(view.answer?.text.trim()).toBe('答案')
  })

  it('连续多次调用按原顺序排列，不合并、不集中到末尾', () => {
    const view = buildReplyView(
      reply([
        { type: 'thinking', thinking: '想' },
        { type: 'memory_action', id: 'memory-a', action: 'save', count: 1 },
        { type: 'memory_action', id: 'memory-b', action: 'profile', count: 1 },
        { type: 'text', text: '答案' },
      ]),
      false
    )
    expect(view.steps.map((step) => (step.type === 'memory' ? step.part.id : step.type))).toEqual([
      'thinking',
      'memory-a',
      'memory-b',
    ])
  })

  it('重开历史时在同一位置还原（同一批 blocks 两次结果一致）', () => {
    const blocks = [
      { type: 'thinking', thinking: '想' },
      { type: 'memory_action', id: 'memory-x', action: 'edit', count: 1 },
      { type: 'thinking', thinking: '再想' },
      {
        type: 'memory_action',
        id: 'memory-y',
        action: 'save',
        count: 0,
        failureReason: 'not_found',
      },
      { type: 'text', text: '答案' },
    ]
    const first = buildReplyView(reply(blocks), false)
    const second = buildReplyView(reply(blocks), false)
    expect(second.steps).toEqual(first.steps)
    expect(first.steps.map((step) => step.type)).toEqual([
      'thinking',
      'memory',
      'thinking',
      'memory',
    ])
  })

  it('视图里只有动作与条数，带不出任何记忆正文', () => {
    const view = buildReplyView(
      reply([
        {
          type: 'memory_action',
          id: 'memory-1',
          action: 'save',
          count: 0,
          failureReason: 'too_close',
        },
        { type: 'text', text: '答案' },
      ]),
      false
    )
    const memory = view.steps.find((step) => step.type === 'memory')
    expect(memory).toBeDefined()
    expect(JSON.stringify(view.steps)).not.toContain('content')
    expect(JSON.stringify(view.steps)).not.toContain('text"')
  })
})
