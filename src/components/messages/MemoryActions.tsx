import { memo } from 'react'
import { isTranslationKey, useTranslate } from '../../i18n/index.js'
import { IconBrainOutline } from '../base/icons.js'
import type { AssistantMessage, MemoryActionPart } from '../../services/chat/types.js'
import styles from './MemoryActions.module.css'

/**
 * 记忆工具的动作记录：一行一个动作，按调用顺序排，不折叠。
 *
 * 内容刻意压到最低——只说做了哪类动作、几条。记忆正文、条目 id、旧→新都不显示：
 * 用户要的是「知道它动了记忆」，不是在这里读记忆内容。
 */
export const MemoryActions = memo(function MemoryActions({ message }: { message: AssistantMessage }) {
  const t = useTranslate()
  const actions = message.blocks.filter((block): block is MemoryActionPart => block.type === 'memory_action')
  // 失败原因只认本地固定文案：block 里存的是 i18n key，不是模型给的字符串
  const reasonText = (key: string | undefined) =>
    isTranslationKey(key) ? t(key) : t('memoryActionFailedUnknown')
  if (actions.length === 0) {
    return null
  }
  return (
    <ul className={styles.list}>
      {actions.map((action) => (
        <li key={action.id} className={action.count > 0 ? styles.row : styles.rowFailed}>
          <span className={styles.icon}>
            <IconBrainOutline size={14} />
          </span>
          <span>
            {action.count === 0
              ? t('memoryActionFailed', { reason: reasonText(action.failureKey) })
              : action.action === 'profile'
                ? t('memoryActionProfile')
                : action.action === 'edit'
                  ? t('memoryActionUpdated', { count: action.count })
                  : t('memoryActionSaved', { count: action.count })}
          </span>
        </li>
      ))}
    </ul>
  )
})
