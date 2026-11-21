import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { toSessionSummary, type Message, type Session, type SessionSummary } from './types.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 13

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/**
 * 记忆条目：内容与向量都只存在这个浏览器里，服务端一张表都没有。
 * 短 id 形如 m3，注入上下文时要带上，模型据此调用 memory_edit。
 */
export type MemoryEntry = {
  id: string
  content: string
  tags: string[]
  vec: Float32Array
  dim: number
  /** 算这条向量的模型名；换模型后旧条目按 dim / model 判失效，不参与检索 */
  model: string
  createdAt: number
  updatedAt: number
  /** 上一版文本，供记忆空间里追溯「已从…改为…」 */
  prevContent: string | null
  /** 来源会话；手动新增的为 null */
  sessionId: string | null
  hitCount: number
  lastUsedAt: number | null
}

/** 用户画像：纯文本，无条件注入上下文；整块重写 */
export type MemoryProfile = { id: 'profile'; text: string; updatedAt: number }

/**
 * 压缩归档：被折叠掉的那些轮次的原文快照（含每轮的 latestReminder）。
 *
 * `session.messages` 仍是唯一真相、压缩从不删消息，这份归档是撤销的兜底：
 * 万一消息列表被别处改动过，撤销时按 id 逐条核对，缺什么补什么。
 */
export type CompactionArchive = {
  id: string
  sessionId: string
  createdAt: number
  messages: Message[]
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
  /** 记忆条目：带向量，检索就在这个 store 上做点积 */
  memories: {
    key: string
    value: MemoryEntry
    indexes: { bySessionId: string; byCreatedAt: number }
  }
  /** 画像单条记录，key 固定为 profile */
  memoryProfile: { key: string; value: MemoryProfile }
  /** 压缩归档：key 是压缩记录的 id */
  compactionArchives: {
    key: string
    value: CompactionArchive
    indexes: { bySessionId: string }
  }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      // 记忆：条目按会话和时间建索引，删除会话时要按会话级联清理
      if (!db.objectStoreNames.contains('memories')) {
        const memories = db.createObjectStore('memories', { keyPath: 'id' })
        memories.createIndex('bySessionId', 'sessionId')
        memories.createIndex('byCreatedAt', 'createdAt')
      }
      if (!db.objectStoreNames.contains('memoryProfile')) {
        db.createObjectStore('memoryProfile', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('compactionArchives')) {
        const archives = db.createObjectStore('compactionArchives', { keyPath: 'id' })
        archives.createIndex('bySessionId', 'sessionId')
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/* ---- 压缩归档：撤销的兜底，不参与请求组装 ---- */

export const saveCompactionArchive = async (archive: CompactionArchive): Promise<void> => {
  await (await getDB()).put('compactionArchives', archive)
}

export const loadCompactionArchive = async (id: string): Promise<CompactionArchive | undefined> =>
  (await getDB()).get('compactionArchives', id)

export const deleteCompactionArchive = async (id: string): Promise<void> => {
  await (await getDB()).delete('compactionArchives', id)
}

/** 删除会话时一并清掉它的压缩归档 */
export const deleteCompactionArchivesBySession = async (sessionId: string): Promise<void> => {
  const db = await getDB()
  const tx = db.transaction('compactionArchives', 'readwrite')
  await Promise.all([
    (async () => {
      for (const key of await tx.store.index('bySessionId').getAllKeys(sessionId)) {
        await tx.store.delete(key)
      }
    })(),
    tx.done,
  ])
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

/**
 * 批量写暂存会话：一个事务写完一批。
 *
 * 安卓 Chrome 上每个事务都要真正落盘，逐个会话开事务时 76 个会话能吃掉几十秒
 * （真机实测 writing 占 96%）；桌面几乎无感，所以这个成本在桌面基准确认不了。
 * 失败时整套暂存由 importHistory 的 catch 清掉，等价于回滚。
 */
export const addStagingSessions = async (sessions: readonly Session[]): Promise<void> => {
  if (sessions.length === 0) {
    return
  }
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([...sessions.map((session) => tx.store.put(session)), tx.done])
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}

/* ---- 记忆：全部只在本机 IndexedDB，没有任何网络写入 ---- */

export const loadMemories = async (): Promise<MemoryEntry[]> => (await getDB()).getAll('memories')

export const loadMemory = async (id: string): Promise<MemoryEntry | undefined> =>
  (await getDB()).get('memories', id)

export const putMemory = async (entry: MemoryEntry): Promise<void> => {
  await (await getDB()).put('memories', entry)
}

export const deleteMemory = async (id: string): Promise<void> => {
  await (await getDB()).delete('memories', id)
}

/** 删除会话时级联清掉它产生的记忆条目（手动新增的条目 sessionId 为 null，不受影响） */
export const deleteMemoriesBySession = async (sessionId: string): Promise<void> => {
  const db = await getDB()
  const tx = db.transaction('memories', 'readwrite')
  await Promise.all([
    (async () => {
      for (const key of await tx.store.index('bySessionId').getAllKeys(sessionId)) {
        await tx.store.delete(key)
      }
    })(),
    tx.done,
  ])
}

export const clearMemories = async (): Promise<void> => {
  const db = await getDB()
  const tx = db.transaction(['memories', 'memoryProfile'], 'readwrite')
  await Promise.all([
    tx.objectStore('memories').clear(),
    tx.objectStore('memoryProfile').clear(),
    tx.done,
  ])
}

export const loadMemoryProfile = async (): Promise<MemoryProfile | undefined> =>
  (await getDB()).get('memoryProfile', 'profile')

export const saveMemoryProfile = async (profile: MemoryProfile): Promise<void> => {
  await (await getDB()).put('memoryProfile', profile)
}
