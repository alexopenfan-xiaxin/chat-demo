/**
 * 上下文用量与压缩的纯计算部分。
 *
 * 用量直接取每条回复的 `usage.input_tokens`——它已经包含缓存命中的部分，就是这一轮请求
 * 送进模型的真实体积；分母按模型满血 1M。
 *
 * 压缩按 aider 的 ChatSummary 思路改：从最后一条往前累计到 150K token 作为保留的原文，
 * 不切断轮次；更早的轮次交给模型总结成一段，作为一条 user 消息放在历史最前。
 * 原文一律不删，压缩只是记一条 `CompactionRecord`，撤销即删除该记录。
 */

import type { AssistantMessage, CompactionRecord, Message, Session, UserMessage } from './types.js'

/** 模型满血上下文：DeepSeek-V4.1-Flash 为 1M */
export const CONTEXT_WINDOW = 1_000_000

/** 四档配色阈值：低于 45% 常态，45% 黄，65% 橙，80% 红 */
export const TIER_WARN = 0.45
export const TIER_HIGH = 0.65
export const TIER_CRITICAL = 0.8

/** 用到 85% 自动压一次 */
export const AUTO_COMPACT_AT = 0.85

/** 压缩后保留的原文预算 */
export const KEEP_TOKENS = 150_000

/** 摘要输出上限；超过就递归再压一层 */
export const SUMMARY_MAX_TOKENS = 4_000
export const MAX_SUMMARY_LAYERS = 3

/** 轮次太少不压：压完只剩一两轮，摘要反而不如原文 */
export const MIN_COMPACT_ROUNDS = 5

/** 摘要作为一条 user 消息放回历史最前；前缀与结尾都照 aider 的通用版 */
export const SUMMARY_PREFIX = '我之前和你聊过一些事。'
export const SUMMARY_SUFFIX = '以上是我们之前对话的摘要，接下来继续。'
/** 摘要后面那条 assistant 占位：aider 用「Ok.」，避免连续两条 user 被当成提问 */
export const SUMMARY_ACK = '好的。'

/** 正文：只拼 text 块，与请求里回传的口径一致 */
const replyText = (reply: AssistantMessage): string =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

/** 与 reply.ts 的 getContextRounds 同口径：提问后紧跟可用回答才算一轮，这里只数个数 */
const usableRounds = (
  messages: readonly Message[]
): (readonly [UserMessage, AssistantMessage])[] => {
  const rounds: (readonly [UserMessage, AssistantMessage])[] = []
  for (let index = 0; index + 1 < messages.length; index += 1) {
    const user = messages[index]
    const reply = messages[index + 1]
    if (
      user?.role === 'user' &&
      reply?.role === 'assistant' &&
      (reply.status === 'done' || reply.status === 'stopped') &&
      reply.stopReason !== 'refusal' &&
      !reply.blocks.some((block) => block.type === 'text' && block.isTemplate) &&
      replyText(reply) !== ''
    ) {
      rounds.push([user, reply])
      index += 1
    }
  }
  return rounds
}

const CJK = /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u

/** 粗估 token：中日韩字符约 1.5 字一个 token，其余约 3.5 字符一个。只在缺少实测用量时兜底。 */
export const estimateTokens = (text: string): number => {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK.test(char)) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return Math.ceil(cjk / 1.5 + other / 3.5)
}

/** 1234 → 1.2K；只用于界面展示 */
export const formatTokenCount = (value: number): string => {
  if (value < 1_000) {
    return String(value)
  }
  if (value < 1_000_000) {
    const k = value / 1_000
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}K`
  }
  const m = value / 1_000_000
  return `${m.toFixed(1).replace(/\.0$/, '')}M`
}

/** 轮次的体积：本轮 input_tokens 是累计值，减去上一轮的累计就是这一轮的增量；没有用量时按字数估。 */
export const roundTokenCosts = (rounds: readonly (readonly [Message, Message])[]): number[] => {
  const costs: number[] = []
  let previous = 0
  for (const [user, reply] of rounds) {
    const usage = reply.role === 'assistant' ? reply.usage : undefined
    if (usage && usage.input_tokens > 0) {
      const delta = Math.max(0, usage.input_tokens - previous)
      previous = usage.input_tokens
      costs.push(delta + usage.output_tokens)
      continue
    }
    const assistant = reply.role === 'assistant' ? replyText(reply) : ''
    const files = user.role === 'user' ? user.files.length : 0
    costs.push(
      estimateTokens(user.role === 'user' ? user.content : '') +
        estimateTokens(assistant) +
        files * 64
    )
  }
  return costs
}

export type CompactionPlan = {
  /** 保留原文从 rounds 的哪一项开始 */
  keepFrom: number
  kept: number
  dropped: number
  droppedTokens: number
  keptTokens: number
}

/**
 * 从最后一条往前累计到预算，得到切分点。轮次是整体，绝不切开。
 * 最后一轮无论如何都保留：单轮就超预算时，保留它比压成摘要更安全。
 */
export const planCompaction = (
  rounds: readonly (readonly [Message, Message])[],
  budget = KEEP_TOKENS
): CompactionPlan | null => {
  if (rounds.length === 0) {
    return null
  }
  const costs = roundTokenCosts(rounds)
  let kept = 0
  let keepFrom = rounds.length
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const cost = costs[index] ?? 0
    if (kept > 0 && kept + cost > budget) {
      break
    }
    kept += cost
    keepFrom = index
  }
  if (keepFrom === 0) {
    return null
  }
  const droppedTokens = costs.slice(0, keepFrom).reduce((sum, cost) => sum + cost, 0)
  return {
    keepFrom,
    kept: rounds.length - keepFrom,
    dropped: keepFrom,
    droppedTokens,
    keptTokens: kept,
  }
}

export type ContextTier = 'normal' | 'warn' | 'high' | 'critical'

export const contextTier = (percent: number): ContextTier => {
  if (percent >= TIER_CRITICAL) {
    return 'critical'
  }
  if (percent >= TIER_HIGH) {
    return 'high'
  }
  if (percent >= TIER_WARN) {
    return 'warn'
  }
  return 'normal'
}

export type ContextUsage = {
  /** 最近一轮实测的 input_tokens；没有实测值是 0 */
  inputTokens: number
  /** 0–1，超过 100% 按 1 算 */
  percent: number
  tier: ContextTier
  /** 当前上下文里的可用轮数 */
  rounds: number
  /** 最近一次压缩的完成时间 */
  compactedAt: number | null
  /** 最近一轮的缓存命中率；没有 input_tokens 时为 null */
  cacheHitRate: number | null
}

/** 从历史里读当前上下文体积：取最后一条带用量的回复，读到空值就沿用上一次的数字。 */
export const readContextUsage = (
  messages: readonly Message[],
  compaction?: CompactionRecord
): ContextUsage => {
  let usage: { input: number; cached: number } | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.usage && message.usage.input_tokens > 0) {
      usage = {
        input: message.usage.input_tokens,
        cached: message.usage.cache_read_input_tokens,
      }
      break
    }
  }
  const inputTokens = usage?.input ?? 0
  const percent = Math.min(1, inputTokens / CONTEXT_WINDOW)
  return {
    inputTokens,
    percent,
    tier: contextTier(percent),
    rounds: usableRounds(messages).length,
    compactedAt: compaction?.createdAt ?? null,
    cacheHitRate: usage && usage.input > 0 ? usage.cached / usage.input : null,
  }
}

/** 压缩是否该自动触发：到 85%，且上一压缩已经有实测的「压缩后」数字（否则同一轮会反复触发） */
export const shouldAutoCompact = (session: Session, messages: readonly Message[]): boolean => {
  const { compaction } = session
  if (compaction && compaction.afterInputTokens === null) {
    return false
  }
  const usage = readContextUsage(messages, compaction)
  if (usage.rounds <= MIN_COMPACT_ROUNDS) {
    return false
  }
  return usage.inputTokens >= CONTEXT_WINDOW * AUTO_COMPACT_AT
}

/**
 * 组装请求时按压缩记录裁剪历史：切分点之前的内容不再逐轮发送，改为一条摘要。
 * 切分点找不到（分支被切换等）时不裁剪，只带摘要，宁可多发也不丢内容。
 */
export const applyCompaction = (
  messages: readonly Message[],
  compaction?: CompactionRecord
): { messages: Message[]; summary: string | null } => {
  const list = [...messages]
  if (!compaction) {
    return { messages: list, summary: null }
  }
  const index = compaction.firstKeptMessageId
    ? list.findIndex((message) => message.id === compaction.firstKeptMessageId)
    : -1
  return {
    messages: index > 0 ? list.slice(index) : list,
    summary: compaction.summary,
  }
}

/** 把要压缩的轮次拍平成给模型看的文字；附件只留文件名，搜索原始结果本来就不回传 */
export const roundsToTranscript = (rounds: readonly (readonly [Message, Message])[]): string =>
  rounds
    .flatMap(([user, reply]) => {
      const parts: string[] = []
      if (user.role === 'user') {
        const files = user.files.map((file) => file.name).filter(Boolean)
        const attachments = files.length > 0 ? `（附件：${files.join('、')}）` : ''
        parts.push(`用户：${user.content}${attachments}`)
      }
      if (reply.role === 'assistant') {
        const text = replyText(reply).trim()
        if (text) {
          parts.push(`助手：${text}`)
        }
      }
      return parts
    })
    .join('\n\n')

/** 摘要提示词：aider 的通用版去掉编程专用条目，只保留对话需要的要求 */
export const SUMMARY_PROMPT = [
  '你是一个对话摘要器。用户会和助手继续之前的对话，请把下面这段对话压成一段摘要，供后续继续使用。',
  '',
  '要求：',
  '- 越靠近结尾的内容记得越详细，靠前的内容可以更概括。',
  '- 按话题分段组织，不要写成按时间排列的流水账。',
  '- 只写事实与结论：用户的目标、已经确定的选择、已经解决的问题、尚未解决的问题、重要的偏好与约束。',
  '- 用用户第一人称陈述，例如「我希望……」「我们决定了……」。',
  '- 不要写「最后」「总结」这类收尾语，不要用代码块，不要写任何客套话。',
  '- 不要包含搜索结果原文，只保留正文里已经得出的结论。',
  '- 只输出摘要正文，不要加标题。',
].join('\n')

export const summaryRequestText = (transcript: string): string =>
  `${SUMMARY_PROMPT}\n\n<对话>\n${transcript}\n</对话>`

/** 摘要本身超长时，把摘要再压一层；仍然超长就按字数硬截，保证不超过上限 */
export const summaryCondenseText = (summary: string): string =>
  `${SUMMARY_PROMPT}\n\n下面是一段已经很长的摘要，请把它压得更短，同样遵守上面的要求。\n\n<摘要>\n${summary}\n</摘要>`

/** 按 token 估算截断，尽量在句末断开 */
export const truncateSummary = (summary: string, maxTokens = SUMMARY_MAX_TOKENS): string => {
  if (estimateTokens(summary) <= maxTokens) {
    return summary
  }
  let out = ''
  let used = 0
  for (const char of summary) {
    const cost = CJK.test(char) ? 1 / 1.5 : 1 / 3.5
    if (used + cost > maxTokens) {
      break
    }
    used += cost
    out += char
  }
  const boundary = Math.max(out.lastIndexOf('。'), out.lastIndexOf('\n'), out.lastIndexOf('！'))
  return boundary > out.length * 0.6 ? out.slice(0, boundary + 1) : out
}
