import { describe, expect, it } from 'vitest'

const { toRequestMessages } = await import('../src/services/chat/reply')

let seq = 0
const user = (content: string) =>
  ({ id: `u${++seq}`, role: 'user', content, files: [], createdAt: 0 }) as never
const assistant = (text: string) =>
  ({
    id: `a${++seq}`,
    role: 'assistant',
    createdAt: 0,
    model: null,
    prefix: true,
    status: 'done',
    blocks: [{ type: 'text', text, citations: [] }],
  }) as never

/**
 * 压缩后请求的形状（针眼要验的第一处）：
 * 摘要作为一条 user 消息放在最前，后面补一条 assistant 占位，否则连续两条 user 会被
 * 模型当成「摘要需要回答」。
 */
describe('压缩后的请求组装', () => {
  it('摘要放最前，紧跟一条 assistant 占位，再接保留的轮次', () => {
    const history = [
      user('第一个问题'),
      assistant('第一个回答'),
      user('第二个问题'),
      assistant('第二个回答'),
    ] as never[]
    const messages = toRequestMessages(
      history,
      user('新问题'),
      undefined,
      false,
      undefined,
      undefined,
      '摘要正文'
    )

    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(String((messages[0] as { content: string }).content)).toContain('摘要正文')
    expect(String((messages[0] as { content: string }).content)).toContain('我之前和你聊过一些事。')
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '好的。' }],
    })
    expect(messages[2]).toMatchObject({ role: 'user' })
    expect(messages.at(-1)).toMatchObject({ role: 'user' })
  })

  it('没有摘要时序列与原来一致，不加占位', () => {
    const history = [user('问题'), assistant('回答')] as never[]
    const messages = toRequestMessages(history, user('新问题'))
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('摘要后面不会出现连续两条 user', () => {
    const history = [user('问题'), assistant('回答')] as never[]
    const messages = toRequestMessages(
      history,
      user('新问题'),
      undefined,
      false,
      undefined,
      undefined,
      '摘要'
    )
    const roles = messages.map((message) => message.role)
    expect(roles.slice(0, 2)).toEqual(['user', 'assistant'])
    for (let index = 1; index < roles.length; index += 1) {
      const previous = roles[index - 1]
      // latest_reminder 是独立角色，会被协议层并进下一条 user，不算连续 user
      if (previous === 'user') {
        expect(roles[index]).not.toBe('user')
      }
    }
  })
})
