import { memo } from 'react'
import clsx from 'clsx'
import { isTranslationKey, useTranslate } from '../../i18n/index.js'
import { MEMORY_REASON_KEYS } from '../../services/memory/reasons.js'
import { IconBrainOutline } from '../base/icons.js'
import type { MemoryActionPart } from '../../services/chat/types.js'
import styles from './MemoryActionRow.module.css'

/**
 * 记忆工具的一行动作记录：渲染在思考过程里，和搜索、读取同一套位置语义。
 *
 * 内容刻意压到最低——只说做了哪类动作、几条。记忆正文、条目 id、旧→新都不显示：
 * 用户要的是「知道它动了记忆」，不是在这里读记忆内容。
 */
export const MemoryActionRow = memo(function MemoryActionRow({ part }: { part: MemoryActionPart }) {
  const t = useTranslate()
  const failed = part.count === 0
  // 失败原因只认枚举；旧消息里存的是 i18n key，兜底再认它，绝不接受自由文本
  const reason = part.failureReason
    ? t(MEMORY_REASON_KEYS[part.failureReason] ?? 'memoryActionFailedUnknown')
    : isTranslationKey(part.failureKey)
      ? t(part.failureKey)
      : t('memoryActionFailedUnknown')
  return (
    <span className={clsx(styles.row, failed && styles.rowFailed)}>
      <span className={styles.icon}>
        <IconBrainOutline size={14} />
      </span>
      <span>
        {failed
          ? t('memoryActionFailed', { reason })
          : part.action === 'profile'
            ? t('memoryActionProfile')
            : part.action === 'edit'
              ? t('memoryActionUpdated', { count: part.count })
              : t('memoryActionSaved', { count: part.count })}
      </span>
    </span>
  )
})
