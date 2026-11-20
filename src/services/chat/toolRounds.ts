/**
 * 工具往返的轮次策略。
 *
 * 到上限**不能截断回复**：用户看到的会是「整段会话被停止」，比少调一次工具恶劣得多。
 * 所以上限之后先换一次「无工具收尾」（不声明 tools，让模型用已有结果把话说完），
 * 只有这一步也失败，才退回那句上限提示。
 */
export const MAX_TOOL_ROUNDS = 10

export type ToolRoundDecision =
  /** 还能继续执行工具 */
  | 'run-tools'
  /** 到上限了：这一轮不执行工具，发一次不带 tools 的请求让模型收尾 */
  | 'finish-without-tools'
  /** 无工具收尾也没说完：这时才显示上限提示 */
  | 'notice'

export const decideToolRound = (rounds: number, finishWithoutTools: boolean): ToolRoundDecision => {
  if (rounds < MAX_TOOL_ROUNDS) {
    return 'run-tools'
  }
  return finishWithoutTools ? 'notice' : 'finish-without-tools'
}
