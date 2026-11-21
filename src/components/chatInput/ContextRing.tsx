import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { getVisibleMessages } from '../../services/chat/branches.js'
import {
  CONTEXT_WINDOW,
  formatTokenCount,
  readContextUsage,
  type ContextTier,
} from '../../services/chat/compaction.js'
import { useChatStore } from '../../services/chat/store.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ContextRing.module.css'

/** 环的几何：直径 20、线宽 2、r=9，周长 2πr = 56.55（与麦克风、回形针并排最接近的一组） */
const DIAMETER = 20
const RADIUS = 9
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const tierClass: Record<ContextTier, string> = {
  normal: styles.normal,
  warn: styles.warn,
  high: styles.high,
  critical: styles.critical,
}

/** 上次压缩：同一天只显示时分，跨天补上日期 */
const formatCompactedAt = (at: number): string => {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return sameDay ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

/**
 * 输入框右侧的上下文用量环。
 *
 * 读数取最后一条回复的 `usage.input_tokens`（已含缓存命中），分母按满血 1M；
 * 没有新数字时自然沿用上一条回复的，新会话为 0。点击展开面板，环本身不写字。
 */
export const ContextRing = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const session = useChatStore((state) =>
    sessionId === null ? undefined : state.sessionCache[sessionId]
  )
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLButtonElement>(null)
  /** 面板固定定位挂在 body 上：输入框容器是 overflow:hidden，放在里面会被裁掉 */
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const rect = ringRef.current?.getBoundingClientRect()
    if (rect) {
      setAnchor({
        right: window.innerWidth - rect.right,
        bottom: window.innerHeight - rect.top + 8,
      })
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const usage = useMemo(
    () => (session ? readContextUsage(getVisibleMessages(session), session.compaction) : null),
    [session]
  )

  // 新会话没有会话记录时不显示：没有数字可看，环会一直被当成 0%
  if (!session || !usage) {
    return null
  }

  const percent = Math.round(usage.percent * 100)
  const offset = CIRCUMFERENCE * (1 - usage.percent)
  const used = formatTokenCount(usage.inputTokens)
  const total = formatTokenCount(CONTEXT_WINDOW)
  const ringLabel = t('contextRingLabel')

  return (
    <div ref={rootRef} className={styles.wrapper}>
      <button
        ref={ringRef}
        type="button"
        className={clsx(styles.ring, tierClass[usage.tier])}
        aria-label={ringLabel}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox={`0 0 ${DIAMETER} ${DIAMETER}`} width={DIAMETER} height={DIAMETER} aria-hidden>
          <circle className={styles.track} cx={DIAMETER / 2} cy={DIAMETER / 2} r={RADIUS} />
          <circle
            className={styles.progress}
            cx={DIAMETER / 2}
            cy={DIAMETER / 2}
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE.toFixed(2)}
            strokeDashoffset={offset.toFixed(2)}
          />
        </svg>
      </button>
      {open && anchor
        ? createPortal(
            <div
              className={styles.panel}
              role="dialog"
              aria-label={ringLabel}
              style={{ right: anchor.right, bottom: anchor.bottom }}
            >
              <div className={styles.title}>{t('contextRingUsed', { used, total, percent })}</div>
              <dl className={styles.rows}>
                <div className={styles.row}>
                  <dt>{t('contextRingCacheHit')}</dt>
                  <dd>
                    {usage.cacheHitRate === null ? '—' : `${Math.round(usage.cacheHitRate * 100)}%`}
                  </dd>
                </div>
                <div className={styles.row}>
                  <dt>{t('contextRingRounds')}</dt>
                  <dd>{usage.rounds}</dd>
                </div>
                <div className={styles.row}>
                  <dt>{t('contextRingLastCompact')}</dt>
                  <dd>
                    {usage.compactedAt === null
                      ? t('contextRingNeverCompacted')
                      : formatCompactedAt(usage.compactedAt)}
                  </dd>
                </div>
              </dl>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
