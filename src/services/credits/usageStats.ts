import { loadSession, loadSessionSummaries } from '../chat/db.js'
import type { AssistantMessage } from '../chat/types.js'

/**
 * 对话级用量：全部从本机 IndexedDB 算，不请求后端。
 *
 * 口径（容易算错的地方）：
 * - 对话 token = Σ(input_tokens + output_tokens)
 *   input_tokens 本身已经含缓存部分，绝不能再加 cache_read_input_tokens
 * - 命中率 = Σ(cache_read_input_tokens) / Σ(input_tokens)
 */
export type RoundUsage = {
  id: string
  inputTokens: number
  cachedTokens: number
  outputTokens: number
}

export type ConversationUsage = {
  id: string
  title: string
  updatedAt: number
  rounds: RoundUsage[]
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  totalTokens: number
  /** 分母为 0 时为 null，前端显示「—」而不是 0% */
  hitRate: number | null
}

const addUsage = (usage: AssistantMessage['usage']): RoundUsage | null => {
  if (!usage) {
    return null
  }
  return {
    id: '',
    inputTokens: usage.input_tokens,
    cachedTokens: usage.cache_read_input_tokens,
    outputTokens: usage.output_tokens,
  }
}

/** 读本机所有会话的用量；会话很多时也只是一次 IndexedDB 遍历 */
export const loadConversationUsage = async (): Promise<ConversationUsage[]> => {
  const summaries = await loadSessionSummaries()
  const list: ConversationUsage[] = []

  for (const summary of summaries) {
    const session = await loadSession(summary.id)
    if (!session) {
      continue
    }
    const rounds: RoundUsage[] = []
    for (const message of session.messages) {
      if (message.role !== 'assistant') {
        continue
      }
      const round = addUsage(message.usage)
      if (round) {
        rounds.push({ ...round, id: message.id })
      }
    }
    if (rounds.length === 0) {
      continue
    }
    const inputTokens = rounds.reduce((sum, round) => sum + round.inputTokens, 0)
    const cachedTokens = rounds.reduce((sum, round) => sum + round.cachedTokens, 0)
    const outputTokens = rounds.reduce((sum, round) => sum + round.outputTokens, 0)
    list.push({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      rounds,
      inputTokens,
      cachedTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      hitRate: inputTokens > 0 ? cachedTokens / inputTokens : null,
    })
  }

  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}
