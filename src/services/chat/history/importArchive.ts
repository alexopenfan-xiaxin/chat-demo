import * as db from '../db.js'
import type { Session } from '../types.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import {
  ArchiveError,
  listArchivePaths,
  readArchive,
  readEntryBlob,
  readEntryText,
  skipEntry,
  type Archive,
  type ArchiveEntry,
} from './zipReader.js'

/** 导入进度：总数取不到时为 null，界面据此退化成不带计数的文案 */
export type ImportProgress = (done: number, total: number | null) => void

/** writing 阶段内部的细分耗时（毫秒），只用于真机定位 */
export type ImportWritingStage = 'read' | 'parse' | 'schema' | 'toLocal' | 'write'
export type ImportWritingTiming = (stage: ImportWritingStage, ms: number) => void

/** 每批写入的会话数：安卓上事务数决定落盘次数，但一批太大又占内存 */
const WRITE_BATCH = 16

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

/**
 * `chat_sessions/<id>_files/<...>`：会话自己的附件条目，目录名以 _files 结尾。
 * 注意不是 `_files/` 前加斜杠——目录名本身就是 `<id>_files`。
 */
export const isAttachmentEntry = (path: string) => /^chat_sessions\/[^/]+_files\/.+/.test(path)

/**
 * 索引与已导入会话必须一一对应：重复、多列、少列都按不完整处理。
 * 官方 v3 导出不一定带索引，那种情况下由会话文件推导出来的索引一定自洽。
 */
export const indexMatchesSessions = (
  entries: readonly { id: string }[],
  imported: ReadonlySet<string>
): boolean => {
  const listed = new Set(entries.map((entry) => entry.id))
  return (
    listed.size === entries.length &&
    listed.size === imported.size &&
    [...imported].every((id) => listed.has(id))
  )
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await readEntryText(entry)
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/**
 * 检查 ZIP 格式、首个 manifest 条目及格式版本。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
export const checkArchiveFormat = async (archive: Archive): Promise<void> => {
  try {
    for await (const entry of readArchive(archive)) {
      if (entry.path !== MANIFEST_PATH) {
        fail('backupUnrecognized')
      }
      checkManifest(await readJson(entry))
      return
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  fail('backupUnrecognized')
}

/**
 * 流式导入：manifest → user（不导入）→ 全部会话 JSON → index → 全部图片。
 * 也支持会话与图片交错排列、index 位于末尾的条目顺序。
 * 会话读完立即暂存，只保留图片路径映射；图片全部读完后逐会话回填 MIME，不改变图片身份。
 * 写入导入暂存存储；调用方负责先清空暂存，成功后替换正式数据，失败时清理暂存。
 */
export const importArchive = async (
  archive: Archive,
  onProgress?: ImportProgress,
  onTiming?: ImportWritingTiming
): Promise<void> => {
  // 总数只数会话文件：中央目录已经打开，纯内存过滤，不再扫盘。
  const total = listArchivePaths(archive).filter((path) => parseSessionPath(path) !== null).length
  onProgress?.(0, total)
  const imported = new Set<string>()
  const images = new Map<string, string>()
  /** 已保存的原件：文件 ID → MIME。同一图片出现在多个会话目录时只保存一次。 */
  const stored = new Map<string, string>()
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  /** 没带索引时按会话文件推导出来的索引，字段与会话一致，不编造 */
  const derived: SessionIndexEntry[] = []

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    const data = await readEntryBlob(entry)
    const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
    await db.saveStagingFiles([{ id, blob: new Blob([data], { type }) }])
    stored.set(id, type)
  }

  /** 待写会话：攒够一批再开事务，减少安卓上的落盘次数 */
  let batch: Session[] = []
  const flush = async () => {
    if (batch.length === 0) {
      return
    }
    const started = performance.now()
    await db.addStagingSessions(batch)
    onTiming?.('write', performance.now() - started)
    batch = []
  }

  try {
    for await (const entry of readArchive(archive)) {
      const { path } = entry
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        checkManifest(await readJson(entry))
        manifest = true
      } else if (path === USER_PATH) {
        // 账号信息（已脱敏）不导入；文件可能缺失，位置也不固定。
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        const readStarted = performance.now()
        const text = await readEntryText(entry)
        onTiming?.('read', performance.now() - readStarted)
        const parseStarted = performance.now()
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          fail('backupInvalidJson')
        }
        onTiming?.('parse', performance.now() - parseStarted)
        const schemaStarted = performance.now()
        const file = readSessionFile(parsed)
        onTiming?.('schema', performance.now() - schemaStarted)
        const localStarted = performance.now()
        const local = toLocalSession(file)
        onTiming?.('toLocal', performance.now() - localStarted)
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        for (const [imagePath, id] of local.images) {
          images.set(imagePath, id)
        }
        // 官方 v3 导出不一定带 chat_session_index.json，缺了就按会话文件补齐，
        // 字段全部来自会话本身，不编造标题和时间。
        derived.push({
          id: file.id,
          title: file.title,
          pinned: false,
          message_count: file.messages.length,
          inserted_at: file.inserted_at,
          updated_at: file.updated_at,
        })
        batch.push(local.session)
        if (batch.length >= WRITE_BATCH) {
          await flush()
        }
        onProgress?.(imported.size, total)
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
      } else if (isAttachmentEntry(path)) {
        // 附件条目与顺序无关：被会话引用就存，没被引用就跳过（导出的孤立产物）。
        const id = images.get(path)
        await (id === undefined ? skipEntry(entry) : saveImage(entry, id))
      } else {
        fail('backupIncomplete')
      }
    }
    await flush()
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (!manifest) {
    fail('backupUnrecognized')
  }
  // 索引只列出成功写出的会话，与会话文件一一对应；没带索引时用推导出来的那份。
  const entries = index ?? derived
  if (entries.length === 0 || !indexMatchesSessions(entries, imported)) {
    fail('backupIncomplete')
  }
  await db.updateStagingFileTypes(stored)
}
