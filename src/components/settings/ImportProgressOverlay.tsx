import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { copyText } from '../../utils/clipboard.js'
import { readImportReports, type ImportRunReport } from '../../services/chat/history/importReport.js'
import type { ImportPhase } from '../../services/chat/history/progress.js'
import { useChatStore } from '../../services/chat/store.js'
import styles from './ImportProgressOverlay.module.css'

/** 还没拿到总数时先不画条；超过这个时间才退到不确定态，避免「先扫动再跳 0%」 */
const PREPARE_GRACE_MS = 600

type View = { done: number; total: number | null; stage: ImportPhase }

/** 导入结束后的停留态：完成或失败都留在这里，用户点「关闭」才走 */
type Result = { report: ImportRunReport; ok: boolean }

const PHASES: ImportPhase[] = ['listing', 'checking', 'writing', 'committing', 'rebuilding']
const WRITING_STAGES = ['read', 'parse', 'schema', 'toLocal', 'write', 'scan', 'image', 'progress', 'other'] as const
/** 解压与 CRC 是 read 内部的拆分，缩进更深一层，只作说明，不参与加总 */
const READ_PARTS = ['crc', 'inflate'] as const

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const pad = (text: string, width: number) => (text.length >= width ? text : text + ' '.repeat(width - text.length))

/**
 * 导入历史对话的进度浮层。
 *
 * 为什么是独立浮层：导入是从设置弹窗里发起的，主区域那条进度被弹窗整个盖住，
 * 而写在某一栏里的那行小字看起来跟说明文字没有区别，用户看不出「它正在动」。
 *
 * 进行中三种形态（数值见 /root/work/ds-chat-import-progress-design.md）：
 *   准备态   还在数文件、且没超过 600ms —— 不画条，只显示阶段与秒数
 *   不确定态 数文件超过 600ms（或拿不到总数）—— 高光横扫，不摆假分母
 *   确定态   开始写入 —— 按 done/total 走，右侧显示 48 / 76
 *
 * 结束后**不再自动消失**：转成完成态/失败态，把分阶段明细摊开给用户自己看、自己选，
 * 点「关闭」才走。原因很实际：浏览器不信任页面时剪贴板会被拒，
 * 而这份数据正是我们要拿来定位真机瓶颈的，不能只留一条复制按钮。
 */
export const ImportProgressOverlay = () => {
  const t = useTranslate()
  const importing = useChatStore((state) => state.importingHistory)
  const progress = useChatStore((state) => state.importProgress)
  const active = importing || progress !== null
  const [mounted, setMounted] = useState(active)
  const [slow, setSlow] = useState(false)
  const [view, setView] = useState<View | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle')
  const startedAt = useRef<number>(Date.now())
  const wasActive = useRef(active)
  /** 秒数单独走 200ms 的心跳，不跟着导入进度刷新，免得把节流又冲掉 */
  const [nowAt, setNowAt] = useState(() => Date.now())

  // 浮层显示期间记下最后一次形态：结束时不能又跳回「已处理 0 个对话」
  useEffect(() => {
    if (progress !== null) {
      setView({ done: progress.done, total: progress.total, stage: progress.stage ?? 'writing' })
    }
  }, [progress])

  useEffect(() => {
    if (!mounted || result !== null) {
      return
    }
    const timer = window.setInterval(() => setNowAt(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [mounted, result])

  useEffect(() => {
    if (active) {
      startedAt.current = Date.now()
      setNowAt(Date.now())
      setMounted(true)
      setSlow(false)
      wasActive.current = true
      return
    }
    if (!wasActive.current) {
      return
    }
    // 导入刚结束：把这一轮的明细摊开，等用户看完点关闭
    wasActive.current = false
    const [report] = readImportReports()
    if (report) {
      setResult({ report, ok: report.outcome === 'ok' })
      setCopyState('idle')
    } else {
      setMounted(false)
      setView(null)
    }
  }, [active])

  // 只有真的慢（>600ms）才从准备态退到不确定态
  useEffect(() => {
    if (!mounted || result !== null) {
      return
    }
    const determinate =
      view !== null && view.total !== null && view.total > 0 && (view.stage === 'writing' || view.done >= view.total)
    if (determinate) {
      return
    }
    const left = PREPARE_GRACE_MS - (Date.now() - startedAt.current)
    if (left <= 0) {
      setSlow(true)
      return
    }
    const timer = window.setTimeout(() => setSlow(true), left)
    return () => window.clearTimeout(timer)
  }, [mounted, result, view])

  // 终态补上键盘用户唯一的出口；进行中仍然全挡
  useEffect(() => {
    if (result === null) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [result])

  if (!mounted) {
    return null
  }

  const close = () => {
    setResult(null)
    setMounted(false)
    setView(null)
  }


  if (result !== null) {
    const { report, ok } = result
    const lines: string[] = []
    lines.push(`${pad(t('historyReportTotal'), 10)}${(report.totalMs / 1000).toFixed(1)}s`)
    lines.push(
      `${pad(t('historyReportEntries'), 10)}${report.entries} · ${t('historyReportSessions')} ${report.sessionsWritten} / ${report.sessionsExpected}`
    )
    lines.push(`${pad(t('historyReportZip'), 10)}${formatBytes(report.zipBytes)}`)
    lines.push('')
    lines.push(t('historyReportPhases'))
    for (const phase of PHASES) {
      const ms = report.phases[phase]
      if (ms === undefined) {
        continue
      }
      const share = Math.round((ms / Math.max(1, report.totalMs)) * 100)
      lines.push(`  ${pad(phase, 11)}${pad(`${ms} ms`, 9)}${share}%`)
      // 整包读入是 listing 里最重的一步（安卓上可能比目录解析慢一个量级），单独列出来
      if (phase === 'listing' && report.detail?.load !== undefined) {
        const loadMs = report.detail.load
        lines.push(
          `      ${pad('load', 11)}${pad(`${loadMs} ms`, 9)}${Math.round((loadMs / Math.max(1, ms)) * 100)}%`
        )
      }
      // writing 内部再拆五段：真机上到底卡在读、解析还是写库，一眼能看出来
      if (phase === 'writing' && report.detail) {
        for (const stage of WRITING_STAGES) {
          const stageMs = report.detail[stage]
          if (stageMs === undefined) {
            continue
          }
          lines.push(`      ${pad(stage, 11)}${pad(`${stageMs} ms`, 9)}${Math.round((stageMs / Math.max(1, ms)) * 100)}%`)
          if (stage === 'read' && report.detail) {
            for (const part of READ_PARTS) {
              const partMs = report.detail[part]
              if (partMs === undefined) {
                continue
              }
              lines.push(`          ${pad(part, 8)}${pad(`${partMs} ms`, 9)}${Math.round((partMs / Math.max(1, stageMs)) * 100)}%`)
            }
          }
        }
      }
    }
    lines.push('')
    // UA 是一长串，跟标签挤在一行会被折断、把两列对齐搞乱，单独起一行
    lines.push(t('historyReportDevice'))
    lines.push(report.environment.ua)
    lines.push(
      `${pad(t('historyReportMemory'), 10)}${report.environment.deviceMemory ?? '?'} GB · ${t('historyReportCores')} ${report.environment.hardwareConcurrency ?? '?'}`
    )
    lines.push(
      `${pad(t('historyReportStorage'), 10)}${formatBytes(report.environment.storageUsage ?? 0)} / ${formatBytes(report.environment.storageQuota ?? 0)}`
    )
    if (report.longTasks) {
      lines.push(
        `${pad(t('historyReportLongTasks'), 10)}${report.longTasks.count} · ${(report.longTasks.totalMs / 1000).toFixed(1)}s · ${t('historyReportLongest', { ms: report.longTasks.maxMs })}`
      )
    }
    if (report.jsHeapBytes) {
      lines.push(`${pad(t('historyReportHeap'), 10)}${formatBytes(report.jsHeapBytes)}`)
    }
    const details = lines.join('\n')

    return createPortal(
      <div className={styles.overlay}>
        <div className={clsx(styles.card, styles.cardResult)} role="dialog" aria-modal="true" aria-live="polite">
          <div className={styles.resultHead}>
            <span className={clsx(styles.resultTitle, !ok && styles.resultTitleFailed)}>
              {ok
                ? t(report.sessionsWritten === 1 ? 'historyImportedOne' : 'historyImported', {
                    count: report.sessionsWritten,
                  })
                : t(report.outcome as 'historyImportFailed')}
            </span>
          </div>
          <div className={styles.resultRow}>
            <div className={styles.resultSubtitle}>
              {t('historyImportElapsed', { seconds: (report.totalMs / 1000).toFixed(2) })}
              {' · '}
              {t('historyReportEntriesShort', { count: report.entries })}
            </div>
            <button
              type="button"
              className={styles.copyLink}
              onClick={() => {
                void copyText(details).then((copied) => setCopyState(copied ? 'done' : 'failed'))
              }}
            >
              {copyState === 'done' ? t('historyImportCopyReportDone') : t('historyImportCopyReport')}
            </button>
          </div>
          {copyState === 'failed' ? (
            <div className={styles.copyFailed} role="status">
              {t('historyCopyFailed')}
            </div>
          ) : null}
          <pre className={styles.details} data-import-details="">
            {details}
          </pre>
          <button type="button" className={styles.closeButton} onClick={close}>
            {t('historyReportClose')}
          </button>
        </div>
      </div>,
      document.body
    )
  }

  const done = view?.done ?? 0
  const total = view?.total ?? null
  const determinate =
    view !== null && view.total !== null && view.total > 0 && (view.stage === 'writing' || view.done >= view.total)
  const percent = determinate && total ? Math.min(100, Math.round((done / total) * 100)) : null
  const preparing = !determinate && !slow
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
