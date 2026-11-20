import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import styles from './ImportProgressOverlay.module.css'

/** total 还没数出来时先什么都不画；超过这个时间才退到不确定态，避免「先扫动再跳 0%」 */
const PREPARE_GRACE_MS = 600
/** 结束后浮层淡出的时长，和 CSS 的 leaving 过渡一致 */
const LEAVE_MS = 160

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 导入历史对话的进度浮层。
 *
 * 为什么是独立浮层：导入是从设置弹窗里发起的，主区域那条进度被弹窗整个盖住，
 * 而写在某一栏里的那行小字看起来跟说明文字没有区别，用户看不出「它正在动」。
 *
 * 三种形态（见 docs 里的视觉规格）：
 *   准备态   total 还没数出来、且没超过 600ms —— 只显示标题与「正在准备…」，不画条
 *   确定态   拿到 total —— 进度条按 done/total 走，右侧显示 48 / 76
 *   不确定态 超过 600ms 仍没拿到 total —— 高光横扫，右侧显示「已处理 N 个对话」
 */
export const ImportProgressOverlay = () => {
  const t = useTranslate()
  const importing = useChatStore((state) => state.importingHistory)
  const progress = useChatStore((state) => state.importProgress)
  const [mounted, setMounted] = useState(importing)
  const [slow, setSlow] = useState(false)
  const [reduced] = useState(prefersReducedMotion)
  const startedAt = useRef<number>(Date.now())

  useEffect(() => {
    if (importing) {
      startedAt.current = Date.now()
      setMounted(true)
      setSlow(false)
      return
    }
    if (!mounted) {
      return
    }
    // 完成或失败：不在这里显示结果，直接淡出，结果落到设置弹窗里，少一次闪烁
    const timer = window.setTimeout(() => setMounted(false), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [importing, mounted])

  const total = progress?.total ?? null
  const done = progress?.done ?? 0
  const determinate = total !== null && total > 0

  // 准备态到不确定态的切换：只有真的慢（>600ms）才画扫动条
  useEffect(() => {
    if (!mounted || determinate) {
      return
    }
    const left = PREPARE_GRACE_MS - (Date.now() - startedAt.current)
    if (left <= 0) {
      setSlow(true)
      return
    }
    const timer = window.setTimeout(() => setSlow(true), left)
    return () => window.clearTimeout(timer)
  }, [mounted, determinate, progress])

  if (!mounted) {
    return null
  }

  const percent = determinate ? Math.min(100, Math.round((done / total) * 100)) : null
  const preparing = !determinate && !slow

  return createPortal(
    <div className={clsx(styles.overlay, !importing && styles.leaving)}>
      <div className={styles.card} role="dialog" aria-modal="true" aria-live="polite">
        <div className={styles.head}>
          <span className={styles.title}>{t('historyImporting')}</span>
          <span className={styles.count}>
            {preparing
              ? t('historyImportPreparing')
              : determinate
                ? `${done} / ${total}`
                : reduced
                  ? t('historyImportWorking')
                  : t('historyImportCount', { count: done })}
          </span>
        </div>
        {preparing ? null : (
          <div
            className={styles.track}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={determinate ? total : undefined}
            aria-valuenow={percent ?? undefined}
          >
            {determinate ? (
              <div className={styles.fill} style={{ width: `${percent}%` }} />
            ) : (
              <div className={clsx(styles.fill, styles.indeterminate)} />
            )}
          </div>
        )}
        {preparing ? null : <div className={styles.hint}>{t('historyImportKeepOpen')}</div>}
      </div>
    </div>,
    document.body
  )
}
