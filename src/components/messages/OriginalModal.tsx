import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Modal } from '../base/Modal.js'
import { getReplyText } from '../../services/chat/reply.js'
import { loadCompactionArchive } from '../../services/chat/db.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { useChatStore } from '../../services/chat/store.js'
import type { CompactionRecord, Message } from '../../services/chat/types.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './OriginalModal.module.css'

/** 只读的原文面板：列出被这次压缩折叠掉的轮次，按「你 / 模型」交替渲染 */
export const OriginalModal = ({
  sessionId,
  record,
  onClose,
}: {
  sessionId: string
  record: CompactionRecord
  onClose: () => void
}) => {
  const t = useTranslate()
  const [messages, setMessages] = useState<Message[] | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [scrollable, setScrollable] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const archive = await loadCompactionArchive(record.id).catch(() => undefined)
      if (cancelled) {
        return
      }
      if (archive) {
        setMessages(archive.messages)
        return
      }
      // 归档丢了就退回会话里的原文：切分点之前的那些消息本来就没删
      const session = useChatStore.getState().sessionCache[sessionId]
      const path = session ? getVisibleMessages(session) : []
      const index = record.firstKeptMessageId
        ? path.findIndex((message) => message.id === record.firstKeptMessageId)
        : 0
      setMessages(index > 0 ? path.slice(0, index) : path)
    })()
    return () => {
      cancelled = true
    }
  }, [record.id, record.firstKeptMessageId, sessionId])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) {
      return
    }
    const update = () => setScrollable(el.scrollHeight > el.clientHeight + 1)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [messages])

  // 相邻的提问与回答算一轮；被拒绝的回答不在归档里，会单独成段
  const rounds: { user: Message | null; reply: Message | null }[] = []
  for (const message of messages ?? []) {
    const last = rounds.at(-1)
    if (message.role === 'user') {
      rounds.push({ user: message, reply: null })
    } else if (last && last.reply === null) {
      last.reply = message
    } else {
      rounds.push({ user: null, reply: message })
    }
  }

  const bodyOf = (message: Message | null) => {
    if (!message) {
      return ''
    }
    return message.role === 'user' ? message.content : getReplyText(message).trim()
  }

  return (
    <Modal
      title={
        <div className={styles.head}>
          <div className={styles.title}>{t('originalModalTitle')}</div>
          <div className={styles.subtitle}>
            {t('originalModalSubtitle', { rounds: record.rounds, count: messages?.length ?? 0 })}
          </div>
        </div>
      }
      closable
      className={styles.panel}
      mainClassName={styles.main}
      onClose={onClose}
    >
      <div ref={scrollerRef} className={styles.scroller}>
        {rounds.map((round, index) => (
          <div key={round.user?.id ?? round.reply?.id ?? index}>
            {index > 0 ? <div className={styles.divider} /> : null}
            {([round.user, round.reply] as (Message | null)[])
              .filter((message): message is Message => message !== null)
              .map((message) => (
                <div key={message.id} className={styles.segment}>
                  <div className={styles.meta}>
                    {message.role === 'user' ? t('originalModalYou') : t('originalModalModel')}
                  </div>
                  <div
                    className={clsx(
                      styles.body,
                      message.role === 'user' ? styles.bodyUser : styles.bodyModel
                    )}
                  >
                    {bodyOf(message) || t('originalModalEmpty')}
                  </div>
                </div>
              ))}
          </div>
        ))}
        {messages === null ? (
          <div className={styles.loading}>{t('originalModalLoading')}</div>
        ) : null}
      </div>
      {scrollable ? <div className={styles.fade} aria-hidden /> : null}
    </Modal>
  )
}
