import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IMPORT_REPORT_KEY,
  createImportRun,
  formatImportReports,
  readImportReports,
  saveImportReport,
  type ImportRunReport,
} from '../src/services/chat/history/importReport'

/** node 里没有 localStorage：用最小的内存实现替代，测的是存取与裁剪逻辑 */
const installStorage = () => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  })
  return store
}

const report = (index: number): ImportRunReport => ({
  startedAt: `2026-11-20T0${index}:00:00.000Z`,
  outcome: 'ok',
  totalMs: 1000 + index,
  zipBytes: 1234,
  entries: 80,
  sessionsExpected: 76,
  sessionsWritten: 76,
  phases: { listing: 10, checking: 5, writing: 900, committing: 60, rebuilding: 25 },
  environment: {
    ua: 'bench',
    hardwareConcurrency: 4,
    deviceMemory: 4,
    storageUsage: 1,
    storageQuota: 2,
    storageFailure: null,
  },
})

describe('导入分阶段计时', () => {
  it('enter 依次封口上一段，finish 封口最后一段', () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const run = createImportRun(0)

    run.enter('listing')
    clock = 120
    run.enter('checking')
    clock = 140
    run.enter('writing')
    clock = 1140
    run.finish()

    expect(run.phases).toEqual({ listing: 120, checking: 20, writing: 1000 })
    expect(Math.round(run.elapsed())).toBe(1140)
    vi.restoreAllMocks()
  })

  it('没走到的阶段不会凭空出现', () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const run = createImportRun(0)
    run.enter('listing')
    clock = 50
    run.finish()
    expect(Object.keys(run.phases)).toEqual(['listing'])
    vi.restoreAllMocks()
  })
})

describe('导入明细存取', () => {
  beforeEach(() => {
    installStorage()
  })

  it('写进去能原样读出来', () => {
    saveImportReport(report(1))
    expect(readImportReports()).toHaveLength(1)
    expect(readImportReports()[0].totalMs).toBe(1001)
  })

  it('只保留最近三次，新的在前', () => {
    for (const index of [1, 2, 3, 4]) {
      saveImportReport(report(index))
    }
    const kept = readImportReports()
    expect(kept).toHaveLength(3)
    expect(kept.map((item) => item.totalMs)).toEqual([1004, 1003, 1002])
  })

  it('存储里是坏数据时按空处理，不抛错', () => {
    localStorage.setItem(IMPORT_REPORT_KEY, '{not json')
    expect(readImportReports()).toEqual([])
  })

  it('导出文本是带 reports 的 JSON', () => {
    const text = formatImportReports([report(1)])
    const parsed = JSON.parse(text) as { exportedAt: string; reports: ImportRunReport[] }
    expect(parsed.reports).toHaveLength(1)
    expect(typeof parsed.exportedAt).toBe('string')
  })
})
