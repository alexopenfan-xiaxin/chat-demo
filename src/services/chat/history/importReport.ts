import type { ImportWritingStage } from './importArchive.js'
import type { ImportPhase } from './progress.js'

/**
 * 报告里单独记账的细分。
 * load 是整包读入（发生在 listing，不算在 writing 里），其余都在 writing 内部。
 */
export type ImportDetailStage = ImportWritingStage | 'load'

/** 一次导入的分阶段实测数据：给真机定位用，别拿桌面或 CPU 节流的数字推真机 */
export type ImportRunReport = {
  startedAt: string
  outcome: 'ok' | string
  totalMs: number
  zipBytes: number
  entries: number
  sessionsExpected: number
  sessionsWritten: number
  /** 各阶段毫秒数，键缺省表示没走到那一阶段 */
  phases: Partial<Record<ImportPhase, number>>
  /** writing 内部细分；other 是 writing 总时长减去其余各项后的未解释缺口 */
  detail?: Partial<Record<ImportDetailStage | 'other', number>>
  /** 主线程长任务：安卓上 GC / 布局这类不归属任何 await 的停顿会落在这里 */
  longTasks?: { count: number; totalMs: number; maxMs: number }
  /** 结束时 JS 堆占用，配合长任务判断是不是 GC 在压 */
  jsHeapBytes?: number | null
  environment: {
    ua: string
    hardwareConcurrency: number | null
    deviceMemory: number | null
    storageUsage: number | null
    storageQuota: number | null
    storageFailure: number | null
  }
}

/** 只留最近几次：定位用，不值得无限堆在 localStorage 里 */
const KEEP = 3

export const scopeImportReportKey = (userId: string | null): string =>
  userId ? `chat-demo:import-report:${userId}` : ''

/**
 * 导入报告跟着账号走：它含会话标题这类摘要，跨账号看见不合适。
 * 未登录时不读也不写（返回空），和存储层「没有作用域就不动数据」保持一致。
 */
let reportScope: string | null = null

export const setImportReportScope = (userId: string | null): void => {
  reportScope = userId
}

export const readImportReports = (): ImportRunReport[] => {
  const key = scopeImportReportKey(reportScope)
  if (!key) {
    return []
  }
  try {
    const raw = localStorage.getItem(key)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ImportRunReport[]) : []
  } catch {
    return []
  }
}

export const formatImportReports = (reports: ImportRunReport[]): string =>
  JSON.stringify({ exportedAt: new Date().toISOString(), reports }, null, 2)

/** 分阶段计时：每次 enter 结束上一段、开始下一段；finish 收尾把当前段封口 */
export const createImportRun = (startedAt: number) => {
  const phases: Partial<Record<ImportPhase, number>> = {}
  const detail: Partial<Record<ImportDetailStage, number>> = {}
  let current: ImportPhase | null = null
  let since = startedAt
  const close = (at: number) => {
    if (current !== null) {
      phases[current] = (phases[current] ?? 0) + (at - since)
    }
    since = at
  }
  return {
    enter(phase: ImportPhase) {
      const at = performance.now()
      close(at)
      current = phase
    },
    finish() {
      close(performance.now())
      current = null
    },
    /** writing 内部的细分累计 */
    addDetail(stage: ImportDetailStage, ms: number) {
      detail[stage] = (detail[stage] ?? 0) + ms
    },
    /** 总计到此刻为止的耗时，phase 里不含还没结束的那一段 */
    elapsed() {
      return performance.now() - startedAt
    },
    phases,
    detail,
  }
}

/** 落盘 + 控制台明细；控制台不可用时也能让用户从界面复制出去 */
/** 长任务观察器：只统计，不做事；环境不支持时静默返回 null */
export const observeLongTasks = () => {
  const supported =
    typeof PerformanceObserver !== 'undefined' &&
    Array.isArray(PerformanceObserver.supportedEntryTypes) &&
    PerformanceObserver.supportedEntryTypes.includes('longtask')
  if (!supported) {
    return null
  }
  let count = 0
  let totalMs = 0
  let maxMs = 0
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      count += 1
      totalMs += entry.duration
      maxMs = Math.max(maxMs, entry.duration)
    }
  })
  observer.observe({ entryTypes: ['longtask'] })
  return {
    stop: () => {
      observer.disconnect()
      return { count, totalMs: Math.round(totalMs), maxMs: Math.round(maxMs) }
    },
  }
}

export const readJsHeap = (): number | null => {
  const memory = (performance as { memory?: { usedJSHeapSize?: number } }).memory
  return memory?.usedJSHeapSize ?? null
}

export const saveImportReport = (report: ImportRunReport): void => {
  const rows = Object.entries(report.phases).map(([phase, ms]) => ({
    阶段: phase,
    毫秒: Math.round(ms as number),
    占比: `${Math.round(((ms as number) / Math.max(1, report.totalMs)) * 100)}%`,
  }))
  // eslint-disable-next-line no-console
  console.table(rows)
  // eslint-disable-next-line no-console
  console.info('import report', report)
  const key = scopeImportReportKey(reportScope)
  if (!key) {
    // 没有账号作用域就不落盘：宁可这次不记，也不写进别人的键
    return
  }
  try {
    const recent = [report, ...readImportReports()].slice(0, KEEP)
    localStorage.setItem(key, JSON.stringify(recent))
  } catch {
    // 存储不可用（隐私模式、配额满）时不要影响导入本身
  }
}

/** 环境信息在导入开始时就取，避免中途 storage.estimate 变慢影响计时 */
export const readEnvironment = async () => {
  let usage: number | null = null
  let quota: number | null = null
  let failure: number | null = null
  try {
    const estimate = await navigator.storage?.estimate?.()
    usage = estimate?.usage ?? null
    quota = estimate?.quota ?? null
  } catch (error) {
    failure = (error as { code?: number })?.code ?? -1
  }
  return {
    ua: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
    storageUsage: usage,
    storageQuota: quota,
    storageFailure: failure,
  }
}
