import { openDB } from 'idb'
import * as db from './chat/db.js'
import { normalizeSession } from './chat/branches.js'
import type { Session } from './chat/types.js'
import { scopeImportReportKey } from './chat/history/importReport.js'

/**
 * 旧库一次性迁移。
 *
 * 分区之前所有数据都在 `chat-demo` 这一个库里；改成 `chat-demo:u:<user.id>` 之后
 * 那段数据在界面上就消失了，文件还在浏览器里。这里把它**复制**进当前账号的库，
 * 旧库原样留着（不读走、不删、不改），出问题还能回退。
 *
 * 为什么不并行读两个库：并行读要回答「哪个库算数」——同一条会话两边都有时听谁的、
 * 新库删了旧库还有时算不算删了。复制一次之后所有代码只面对一个库，分歧消失。
 *
 * 只迁一次：迁完写浏览器级标记。标记放 localStorage 而不是 IndexedDB，因为它描述的是
 * 「这台浏览器已经做过迁移」，与哪个账号无关——多个账号共用浏览器时，只有第一个
 * 登录并触发迁移的账号会拿到旧数据，不会重复归给后来的人。
 */

/** 旧库名，与分区前的库名一致 */
export const LEGACY_DB = 'chat-demo'
/** 迁移完成的浏览器级标记 */
export const LEGACY_MIGRATED_FLAG = 'chat-demo:legacy-migrated'
/** 分区前导入报告的键（没有账号后缀） */
const LEGACY_REPORT_KEY = 'chat-demo:import-report'

export type LegacyStats = { sessions: number; memories: number }

export type LegacyMigrateResult =
  | { status: 'skipped'; reason: 'migrated' | 'target-not-empty' | 'no-legacy' }
  | { status: 'done'; stats: LegacyStats }
  | { status: 'failed'; error: string }

/**
 * 这台浏览器有哪些库。
 *
 * 先问 `indexedDB.databases()` 是为了不在检测阶段凭空建出一个空库——
 * 用 `openDB(name)` 打开不存在的库会创建一个。拿不到清单时返回 null，
 * 调用方退回「打开后看有没有 store」的探测方式。
 */
const listDatabaseNames = async (): Promise<Set<string> | null> => {
  const withDatabases = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }
  if (typeof withDatabases.databases !== 'function') {
    return null
  }
  try {
    const list = await withDatabases.databases()
    const names = list
      .map((item) => item.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
    return new Set(names)
  } catch {
    return null
  }
}

/** 打开旧库；不存在或没有会话存储时返回 null（不升级、不写入） */
const openLegacy = async () => {
  const names = await listDatabaseNames()
  if (names && !names.has(LEGACY_DB)) {
    return null
  }
  const handle = await openDB(LEGACY_DB)
  if (!handle.objectStoreNames.contains('sessions')) {
    // 拿不到清单时可能刚建出一个空库：它不是旧数据，按不存在处理
    handle.close()
    return null
  }
  return handle
}

/** 旧库里有多少可迁的东西；没有旧库或旧库为空时返回 null */
export const inspectLegacy = async (): Promise<LegacyStats | null> => {
  const legacy = await openLegacy()
  if (!legacy) {
    return null
  }
  try {
    const sessions = await legacy.count('sessions')
    const memories = legacy.objectStoreNames.contains('memories')
      ? await legacy.count('memories')
      : 0
    return sessions > 0 || memories > 0 ? { sessions, memories } : null
  } finally {
    legacy.close()
  }
}

const readTarget = async (): Promise<{ sessions: number; memories: number }> => ({
  sessions: (await db.loadSessionSummaries()).length,
  memories: (await db.loadMemories()).length,
})

/** 把旧库的导入报告搬到当前账号的键上；新键已有内容时不覆盖 */
const migrateImportReport = (userId: string): void => {
  const target = scopeImportReportKey(userId)
  if (!target) {
    return
  }
  try {
    const raw = localStorage.getItem(LEGACY_REPORT_KEY)
    if (!raw || localStorage.getItem(target)) {
      return
    }
    localStorage.setItem(target, raw)
  } catch {
    // 报告只是诊断数据，隐私模式下写不进去也不该让迁移失败
  }
}

/**
 * 跑一次迁移。调用方负责在登录态落定后调用，并按返回值决定要不要提示。
 *
 * `userId` 只用于导入报告分键；会话、记忆、画像都通过 `db.*` 写入，
 * 因此自动带上当前作用域与世代校验——切号中途被打断就按作废处理。
 */
export const migrateLegacyOnce = async (
  userId: string,
  onProgress?: (done: number, total: number) => void
): Promise<LegacyMigrateResult> => {
  try {
    if (localStorage.getItem(LEGACY_MIGRATED_FLAG)) {
      return { status: 'skipped', reason: 'migrated' }
    }
  } catch {
    // localStorage 不可用（隐私模式）：退回每次启动都检查，至少不会静默不迁
  }

  const legacy = await openLegacy()
  if (!legacy) {
    return { status: 'skipped', reason: 'no-legacy' }
  }

  try {
    const sessions = (await legacy.getAll('sessions')) as Session[]
    const memories = legacy.objectStoreNames.contains('memories')
      ? await legacy.getAll('memories')
      : []
    const profile = legacy.objectStoreNames.contains('memoryProfile')
      ? await legacy.get('memoryProfile', 'profile')
      : undefined

    if (sessions.length === 0 && memories.length === 0) {
      return { status: 'skipped', reason: 'no-legacy' }
    }

    // 只在当前账号库为空时迁：已有数据说明这台浏览器的主账号已经建起来了，
    // 再合一次就得处理 id 冲突与「谁的更可信」，那是另一件事
    const target = await readTarget()
    if (target.sessions > 0 || target.memories > 0) {
      return { status: 'skipped', reason: 'target-not-empty' }
    }

    const total = sessions.length + memories.length + 1
    let done = 0
    onProgress?.(done, total)

    // 会话里引用的附件原件也在这台浏览器里：不搬的话历史消息的图片全变破图
    const fileIds = new Set<string>()
    for (const session of sessions) {
      const normalized = normalizeSession(session)
      for (const message of normalized.messages) {
        if (message.role === 'user') {
          for (const file of message.files) {
            fileIds.add(file.id)
          }
        }
      }
      await db.saveSession(normalized)
      done += 1
      onProgress?.(done, total)
    }

    // 只搬被引用到的原件：旧库里没人引用的孤立文件不必复制一份占地方
    if (fileIds.size > 0 && legacy.objectStoreNames.contains('files')) {
      const files: db.StoredFile[] = []
      for (const id of fileIds) {
        const stored = await legacy.get('files', id)
        if (stored?.blob) {
          files.push(stored)
        }
      }
      if (files.length > 0) {
        await db.saveFiles(files)
      }
    }
    for (const entry of memories) {
      await db.putMemory(entry)
      done += 1
      onProgress?.(done, total)
    }
    if (profile) {
      await db.saveMemoryProfile(profile)
    }
    done += 1
    onProgress?.(done, total)

    migrateImportReport(userId)

    try {
      localStorage.setItem(LEGACY_MIGRATED_FLAG, new Date().toISOString())
    } catch {
      // 写不进标记就退化成「这台浏览器每次启动检查一次」，检查本身是幂等的
    }

    return { status: 'done', stats: { sessions: sessions.length, memories: memories.length } }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : '迁移失败' }
  } finally {
    legacy.close()
  }
}
