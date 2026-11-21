import clsx from 'clsx'
import { useState } from 'react'
import { IconChevronDownOutline14 } from '../base/icons.js'
import { formatTokenCount } from '../../services/chat/compaction.js'
import { undoCompaction } from '../../services/chat/store.js'
import type { CompactionRecord } from '../../services/chat/types.js'
import { OriginalModal } from './OriginalModal.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './CompactionRow.module.css'

/**
 * 历史里那行「已压缩 N 轮，减少 X tokens」。
 *
 * 压缩只改请求组装、不改消息，所以原文仍在上面照常显示，这一行标出「从这里往前的轮次
 * 不再逐轮发给模型」。展开看摘要，也可以一键撤销（删掉记录即恢复原文）。
 */
export const CompactionRow = ({
  sessionId,
  record,
}: {
  sessionId: string
  record: CompactionRecord
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const reduced =
    record.afterInputTokens === null
      ? null
      : Math.max(0, record.beforeInputTokens - record.afterInputTokens)

  return (
    <div className={styles.wrapper}>
      <button
        type="button"
        className={styles.row}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={clsx(styles.chevron, open && styles.chevronOpen)} aria-hidden>
          <IconChevronDownOutline14 />
        </span>
        <span className={styles.label}>
          {reduced === null
            ? t('compactionRowRounds', { rounds: record.rounds })
            : t('compactionRowRoundsTokens', {
                rounds: record.rounds,
                tokens: formatTokenCount(reduced),
              })}
        </span>
      </button>
      {open ? (
        <div className={styles.detail}>
          <p className={styles.summary}>{record.summary}</p>
          <div className={styles.actions}>
            <button type="button" className={styles.action} onClick={() => setShowOriginal(true)}>
              {t('compactionViewOriginal')}
            </button>
            <button
              type="button"
              className={styles.action}
              onClick={() => undoCompaction(sessionId)}
            >
              {t('compactionUndo')}
            </button>
          </div>
        </div>
      ) : null}
      {showOriginal ? (
        <OriginalModal
          sessionId={sessionId}
          record={record}
          onClose={() => setShowOriginal(false)}
        />
      ) : null}
    </div>
  )
}
