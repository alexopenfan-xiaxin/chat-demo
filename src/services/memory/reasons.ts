import type { TranslationKey } from '../../i18n/index.js'

/**
 * 记忆工具的失败原因枚举。
 *
 * 为什么要枚举：界面曾靠中文文案的子串反推（「最多」→ 超长、「相近」→ 冲突），
 * 任何新文案不含关键词就会掉到「未知原因」。现在写入口直接给出枚举，界面只认枚举，
 * 顺带保证界面上永远不可能拼出记忆正文——枚举里没有任何自由文本。
 */
export type MemoryFailReason =
  | 'empty'
  | 'too_long'
  | 'not_configured'
  | 'embed_failed'
  | 'not_found'
  | 'ambiguous'
  | 'too_close'

/** 枚举 → 文案 key。未知值一律落到「本地写入失败」 */
export const MEMORY_REASON_KEYS: Record<MemoryFailReason, TranslationKey> = {
  empty: 'memoryActionFailedEmpty',
  too_long: 'memoryActionFailedTooLong',
  not_configured: 'memoryActionFailedUnavailable',
  embed_failed: 'memoryActionFailedEmbedding',
  not_found: 'memoryActionFailedMissing',
  ambiguous: 'memoryActionFailedAmbiguous',
  too_close: 'memoryActionFailedConflict',
}
