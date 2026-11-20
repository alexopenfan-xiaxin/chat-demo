import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import type { ImportPhase } from '../../services/chat/history/progress.js'
import { useChatStore } from '../../services/chat/store.js'
import styles from './ImportProgressOverlay.module.css'

/** 还没拿到总数时先不画条；超过这个时间才退到不确定态，避免「先扫动再跳 0%」 */
const PREPARE_GRACE_MS = 600
/** 结束后浮层淡出的时长，和 CSS 的 leaving 过渡一致 */
const LEAVE_MS = 160

type View = { done: number; total: number | null; stage: ImportPhase }

/**
 * 导入历史对话的进度浮层。
 *
 * 为什么是独立浮层：导入是从设置弹窗里发起的，主区域那条进度被弹窗整个盖住，
 * 而写在某一栏里的那行小字看起来跟说明文字没有区别，用户看不出「它正在动」。
 *
 * 三种形态（数值见 /root/work/ds-chat-import-progress-design.md）：
 *   准备态   还在数文件、且没超过 600ms —— 只有标题与「正在准备…」，不画条
 *   不确定态 数文件超过 600ms（或拿不到总数）—— 高光横扫，不摆假分母
 *   确定态   开始写入 —— 按 done/total 走，右侧显示 48 / 76
 *
 * 结束时不在这里显示结果：直接淡出，结果落到设置弹窗，少一次闪烁。
 */
export const ImportProgressOverlay = () => {
  const t = useTranslate()
  const importing = useChatStore((state) => state.importingHistory)
  const progress = useChatStore((state) => state.importProgress)
  const active = importing || progress !== null
  const [mounted, setMounted] = useState(active)
  const [slow, setSlow] = useState(false)
  const [view, setView] = useState<View | null>(null)
  const startedAt = useRef<number>(Date.now())
  /** 秒数单独走 200ms 的心跳，不跟着导入进度刷新，免得把节流又冲掉 */
  const [nowAt, setNowAt] = useState(() => Date.now())

  // 浮层显示期间记下最后一次形态：淡出那 160ms 不能又跳回「已处理 0 个对话」
  useEffect(() => {
    if (progress !== null) {
      setView({ done: progress.done, total: progress.total, stage: progress.stage ?? 'writing' })
    }
  }, [progress])

  useEffect(() => {
    if (!mounted) {
      return
    }
    const timer = window.setInterval(() => setNowAt(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [mounted])

  useEffect(() => {
    if (active) {
      startedAt.current = Date.now()
      setNowAt(Date.now())
      setMounted(true)
      setSlow(false)
      return
    }
    if (!mounted) {
      return
    }
    const timer = window.setTimeout(() => {
      setMounted(false)
      setView(null)
    }, LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [active, mounted])

  // 写入阶段按 done/total 走；提交与整理阶段写入已到齐，条也该是满的，不能退回不确定态
  const determinate =
    view !== null &&
    view.total !== null &&
    view.total > 0 &&
    (view.stage === 'writing' || view.done >= view.total)
  const waiting = !determinate

  // 只有真的慢（>600ms）才从准备态退到不确定态
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
  }, [mounted, determinate, view])

  if (!mounted) {
    return null
  }

  const done = view?.done ?? 0
  const total = view?.total ?? null
  const percent = determinate && total ? Math.min(100, Math.round((done / total) * 100)) : null
  const preparing = waiting && !slow
  const stage = view?.stage ?? 'listing'
  const phaseTitle = t(
    stage === 'checking'
      ? 'historyPhaseChecking'
      : stage === 'writing'
        ? 'historyPhaseWriting'
        : stage === 'committing'
          ? 'historyPhaseCommitting'
          : stage === 'rebuilding'
            ? 'historyPhaseRebuilding'
            : 'historyPhaseListing'
  )
  const elapsed = Math.max(0, (nowAt - startedAt.current) / 1000).toFixed(1)

  return createPortal(
    <div className={clsx(styles.overlay, !active && styles.leaving)}>
      <div className={styles.card} role="dialog" aria-modal="true" aria-live="polite">
        <div className={styles.head}>
          <span className={styles.title}>{phaseTitle}</span>
          <span className={styles.count}>
            {determinate
              ? `${done} / ${total}`
              : stage === 'listing'
                ? t('historyImportReadingList', { count: done })
                : total !== null && done >= total
                  ? `${done} / ${total}`
                  : ''}
          </span>
        </div>
        <div
          className={clsx(styles.track, preparing && styles.hidden)}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={determinate ? (total ?? undefined) : undefined}
          aria-valuenow={percent ?? undefined}
        >
          {determinate ? (
            <div className={styles.fill} style={{ width: `${percent}%` }} />
          ) : preparing ? null : (
            <div className={clsx(styles.fill, styles.indeterminate)} />
          )}
        </div>
        {/* 准备态也显示秒数：用户从点确认起就能看到在走，而不是只看到一句「正在准备」 */}
        <div className={styles.hint}>
          {t('historyImportElapsed', { seconds: elapsed })}
          {' · '}
          {t('historyImportKeepOpen')}
        </div>
      </div>
    </div>,
    document.body
  )
}
