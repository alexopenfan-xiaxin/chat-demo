import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import { replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

import { BackupError } from './history/errors.js'
import {
  createImportRun,
  readEnvironment,
  saveImportReport,
  type ImportRunReport,
} from './history/importReport.js'
import { createProgressReporter } from './history/progress.js'

export { BackupError }

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
export const importHistory = (file: File): Promise<number> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    const { isZipFile, openArchive, ArchiveError } = await import('./history/zipReader.js')
    const { parseSessionPath } = await import('./history/paths.js')
    // 从点确认那一刻起算，报告与浮层的秒数用同一个起点
    const startedAt = performance.now()
    const run = createImportRun(startedAt)
    const environment = await readEnvironment()
    // 节流：目录解析与逐条写入都可能触发几十上百次，每次都 setState 会让 React 反复渲染
    const stage = createProgressReporter((value) => useChatStore.setState({ importProgress: value }))
    const report = (outcome: string, sessions: number, entries: number, expected: number) => {
      run.finish()
      const value: ImportRunReport = {
        startedAt: new Date().toISOString(),
        outcome,
        totalMs: Math.round(run.elapsed()),
        zipBytes: file.size,
        entries,
        sessionsExpected: expected,
        sessionsWritten: sessions,
        phases: Object.fromEntries(
          Object.entries(run.phases).map(([phase, ms]) => [phase, Math.round(ms as number)])
        ) as ImportRunReport['phases'],
        environment,
      }
      saveImportReport(value)
    }
    let archive: Awaited<ReturnType<typeof openArchive>> | null = null
    let written = 0
    run.enter('listing')
    stage(0, null, 'listing', true)
    try {
      if (!(await isZipFile(file))) {
        throw new BackupError('backupUnrecognized')
      }
      try {
        // 目录只读这一次：后面校验与导入都复用它（见 zipReader 的 Archive）
        archive = await openArchive(file, (parsed) => stage(parsed, null, 'listing'))
      } catch (error) {
        throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
      }
      run.enter('checking')
      stage(0, null, 'checking', true)
      await checkArchiveFormat(archive)
      // 只数会话文件；图片目录 chat_sessions/<id>_files/... 不算
      const expected = archive.entries.filter(
        (entry) => parseSessionPath(entry.path) !== null
      ).length
      const count = await replaceHistory(
        async () => {
          run.enter('writing')
          await importArchive(archive as NonNullable<typeof archive>, (done, totalSessions) =>
            stage(done, totalSessions, 'writing')
          )
        },
        (phase) => {
          run.enter(phase)
          // 提交与整理阶段：写入已经到齐，计数位就停在 N / N，不留一个假的 0
          stage(expected, expected, phase, true)
        }
      )
      written = count
      report('ok', count, archive.entries.length, expected)
      return count
    } catch (error) {
      const key = error instanceof BackupError ? error.key : 'historyImportFailed'
      report(key, written, archive?.entries.length ?? 0, 0)
      throw error
    } finally {
      useChatStore.setState({ importProgress: null })
    }
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
