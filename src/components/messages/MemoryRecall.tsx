import { memo, useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconMemoryOutline14,
} from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import styles from './MemoryRecall.module.css'

/**
 * 回复上方的「参考了 N 条过往记忆」提示条。
 *
 * 记忆是模型自己存、自己改的，用户必须能看见这一轮到底参考了什么，
 * 否则记错了也无从发现。点开列出条目 id、分数与来源会话，收起靠再点一次；
 * 不做浮层、不自动展开，避免每条回复前形成噪音。
 */
export const MemoryRecall = memo(function MemoryRecall({ message }: { message: AssistantMessage }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const sessions = useChatStore((state) => state.sessions)
  const items = message.recall ?? []
  if (items.length === 0) {
    return null
  }

  const sourceOf = (id: string | null) => {
    if (!id) {
      return t('memoryRecallLocal')
    }
    const title = sessions.find((session) => session.id === id)?.title?.trim()
    return title || t('memoryRecallDeleted')
  }

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.pill}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className={styles.icon}>
          <IconMemoryOutline14 />
        </span>
        <span>{t('memoryRecallHint', { count: items.length })}</span>
        {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
      </button>
      {open ? (
        <div className={styles.panel}>
          {items.map((item, index) => (
            <div key={item.id} className={clsx(styles.item, index === 0 && styles.itemFirst)}>
              <div className={styles.meta}>
                <span className={styles.id}>[{item.id}]</span>
                <span className={styles.source}>{sourceOf(item.sessionId)}</span>
                <span className={styles.score}>{item.score.toFixed(2)}</span>
              </div>
              <div className={styles.content}>{item.content}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
})
