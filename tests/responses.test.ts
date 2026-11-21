import { describe, expect, it } from 'vitest'
import { toResponsesBody } from '../src/services/api/responses'
import type { CreateMessageRequest } from '../src/services/api/types'

const request = (overrides: Partial<CreateMessageRequest> = {}): CreateMessageRequest => ({
  model: 'deepseek-flash',
  system: '你是deepseek，由深度求索公司创造。',
  messages: [{ role: 'user', content: 'deepseek v4 什么时候发布的' }],
  thinking: { type: 'disabled' },
  tools: [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '搜索互联网',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    },
  ],
  safety_check: { level: 'high' },
  ...overrides,
})

describe('toResponsesBody 的工具往返', () => {
  it('模型上一轮说的话排在 function_call 之前', () => {
    const body = toResponsesBody(
      request({
        toolExchange: [
          { role: 'assistant', content: '我搜一下。' },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'web_search',
            arguments: '{"query":"V4"}',
          },
          { type: 'function_call_output', call_id: 'call_1', output: '{"results":[]}' },
        ],
      })
    ) as { input: Array<Record<string, unknown>> }
    expect(body.input.map((item) => item.type ?? item.role)).toEqual([
      'user',
      'assistant',
      'function_call',
      'function_call_output',
    ])
  })

  it('没有工具往返时 input 只有消息本身', () => {
    const body = toResponsesBody(request()) as { input: Array<Record<string, unknown>> }
    expect(body.input).toHaveLength(1)
    expect(body.input[0]).toMatchObject({ role: 'user' })
  })
})
