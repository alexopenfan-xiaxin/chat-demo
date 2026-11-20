import { describe, expect, it } from 'vitest'
import { MAX_TOOL_ROUNDS, decideToolRound } from '../src/services/chat/toolRounds'

/**
 * 工具轮次的收尾策略。
 *
 * 之前的行为是「到 3 轮就截断回复」，用户看到的是整段会话被停止、只留一句模板话，
 * 属于恶性问题。现在的口径：轮次上限只是「不再执行工具」，不是「不再说话」——
 * 到上限先换一次不带 tools 的请求让模型把已有结果说完，只有那一步也失败才显示上限提示。
 */
describe('工具轮次策略', () => {
  it('上限是 10 轮', () => {
    expect(MAX_TOOL_ROUNDS).toBe(10)
  })

  it('4 轮工具调用之后仍然继续，不会冒出「已达上限」', () => {
    // 用户实测的场景：2 次搜索 + 2 次记忆写入，第 4 轮之后必须能正常收尾
    for (const rounds of [0, 1, 2, 3, 4]) {
      expect(decideToolRound(rounds, false)).toBe('run-tools')
    }
  })

  it('到上限先走无工具收尾，不直接给上限提示', () => {
    expect(decideToolRound(MAX_TOOL_ROUNDS, false)).toBe('finish-without-tools')
    expect(decideToolRound(MAX_TOOL_ROUNDS - 1, false)).toBe('run-tools')
  })

  it('无工具收尾之后还调工具，才显示上限提示', () => {
    expect(decideToolRound(MAX_TOOL_ROUNDS, true)).toBe('notice')
  })
})
