import type { ImportWritingStage } from './importArchive.js'
import type { ImportPhase } from './progress.js'

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
  /** writing 内部细分：读+解压、JSON.parse、schema 校验、转本地、真正写库 */
  detail?: Partial<Record<ImportWritingStage, number>>
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

export const IMPORT_REPORT_KEY = 'chat-demo:import-report'

export const readImportReports = (): ImportRunReport[] => {
  try {
    const raw = localStorage.getItem(IMPORT_REPORT_KEY)
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
  const detail: Partial<Record<ImportWritingStage, number>> = {}
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
    addDetail(stage: ImportWritingStage, ms: number) {
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
  try {
    const recent = [report, ...readImportReports()].slice(0, KEEP)
    localStorage.setItem(IMPORT_REPORT_KEY, JSON.stringify(recent))
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
