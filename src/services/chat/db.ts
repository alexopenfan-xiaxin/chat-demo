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

import {
  ScopeMismatchError,
  currentScopeUserId,
  isScopeMismatch,
  scopeFingerprint,
  scopeState,
} from './scope.js'

export { ScopeMismatchError, currentScopeUserId, isScopeMismatch, scopeFingerprint }
/** 正在进行的读写事务数：切号要等它们收尾 */
let activeWrites = 0
let settleQueue: Array<() => void> = []


let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

/**
 * 库名 = `chat-demo:u:<user.id>`，**原样拼接、不做任何改写**。
 *
 * `user.id` 是 users 表里的 UUID（36 位、带连字符，注册时由 `crypto.randomUUID()` 生成），
 * 既不是邮箱也不是会话票，所以同一账号反复登录拿到的库名不变。
 * 不截断、不去连字符：把 36 位压成 32 位会引入「两个不同 id 映射到同一库名」的可能。
 */
const USER_ID = /^[a-f0-9-]{1,36}$/

export const dbNameFor = (userId: string): string => {
  const normalized = userId.toLowerCase()
  if (!USER_ID.test(normalized)) {
    throw new Error(`invalid user id for storage scope: ${JSON.stringify(userId).slice(0, 40)}`)
  }
  return `chat-demo:u:${normalized}`
}



const endWrite = () => {
  activeWrites -= 1
  if (activeWrites <= 0) {
    activeWrites = 0
    for (const resolve of settleQueue.splice(0)) {
      resolve()
    }
  }
}

/** 等正在进行的读写收尾（切号顺序：先中止流，再等这里，最后换库） */
export const drainWrites = async (): Promise<void> => {
  if (activeWrites === 0) {
    return
  }
  await new Promise<void>((resolve) => settleQueue.push(resolve))
}

/**
 * 切账号作用域。调用方必须先中止所有在跑的流，再调这里。
 *
 * 顺序是固定的：先把世代推进一步（旧连接的所有写入口立刻开始拒绝）→ 等在途事务收尾
 * → 才置空连接、换库名。反过来做的话，已经拿到旧连接的事务会继续把数据写进旧库。
 */
export const setStorageScope = async (userId: string | null): Promise<void> => {
  if (userId === scopeState.userId && !scopeState.switching) {
    return
  }
  scopeState.switching = true
  // 世代先推进：旧连接上的写入口立刻开始拒绝
  scopeState.generation += 1
  try {
    // 等在途事务收尾，再换库
    await drainWrites()
    const previous = dbPromise
    dbPromise = null
    scopeState.userId = userId
    if (previous) {
      void previous
        .then((db) => db.close())
        .catch(() => undefined)
    }
  } finally {
    scopeState.switching = false
  }
}

const WRITE_METHODS = new Set(['put', 'add', 'delete', 'clear'])

/** 读写事务按世代守卫：过期世代的写一律抛 ScopeMismatchError，事务随之回滚 */
const guardTransaction = <T extends object>(tx: T, generation: number): T =>
  new Proxy(tx, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') {
        return value
      }
      if (prop === 'objectStore' || prop === 'store') {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args)
          if (prop === 'store') {
            return guardStoreObject(result as object, generation)
          }
          return guardStoreObject(result as object, generation)
        }
      }
      return (value as (...a: unknown[]) => unknown).bind(target)
    },
  })

const guardStoreObject = <T extends object>(store: T, generation: number): T =>
  new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') {
        return value
      }
      if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          if (generation !== scopeState.generation) {
            throw new ScopeMismatchError()
          }
          // 直连 db.put 也要算进在途写，否则切号不会等它
          activeWrites += 1
          try {
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          } finally {
            queueMicrotask(endWrite)
          }
        }
      }
      return (value as (...a: unknown[]) => unknown).bind(target)
    },
  })

/** 连接只在作用域内有效：世代一过期，旧连接上的任何事务都拒绝 */
const guardConnection = <T extends object>(db: T, generation: number): T =>
  new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') {
        return value
      }
      if (prop === 'transaction') {
        return (...args: unknown[]) => {
          if (generation !== scopeState.generation) {
            throw new ScopeMismatchError()
          }
          const readwrite = args[1] === 'readwrite'
          if (readwrite) {
            activeWrites += 1
          }
          const tx = (value as (...a: unknown[]) => unknown).apply(target, args) as object & {
            done?: Promise<unknown>
          }
          if (readwrite) {
            void Promise.resolve(tx.done).catch(() => undefined).finally(endWrite)
          }
          return guardTransaction(tx, generation)
        }
      }
      if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          if (generation !== scopeState.generation) {
            throw new ScopeMismatchError()
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return (value as (...a: unknown[]) => unknown).bind(target)
    },
  })

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
const getDB = (): Promise<IDBPDatabase<ChatDB>> => {
  if (!scopeState.userId || scopeState.switching) {
    // 启动时序错位时这里会让界面看起来「数据全没了」，留一条线索便于定位
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[storage] read/write rejected: no account scope or switching', {
        userId: scopeState.userId,
        switching: scopeState.switching,
      })
    }
    // 未登录、或正在切号：不建库、不写。抛同一个错误，调用方按「这次读写作废」处理
    return Promise.reject(new ScopeMismatchError())
  }
  const generation = scopeState.generation
  const name = dbNameFor(scopeState.userId)
  return (dbPromise ??= openDB<ChatDB>(name, DB_VERSION, {
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
  })
    .then((db) => guardConnection(db, generation))
    .catch((error: unknown) => {
      // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
      dbPromise = null
      throw error
    }))
}

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

/** 旧库迁移要一次写进去的东西：会话、附件原件、记忆、画像 */
export type LegacyBundle = {
  sessions: Session[]
  files: StoredFile[]
  memories: MemoryEntry[]
  profile?: MemoryProfile
}

/**
 * 旧库迁移的整包写入：一个跨 store 的 `readwrite` 事务，失败整体回滚。
 *
 * 为什么必须原子：分条写一旦中途失败就留下半截库，而「目标库为空才迁」这条判据
 * 在重试时看到非空就再也不敢补写——半截数据会被永久冻在那里。一次提交让
 * 「要么全在、要么全不在」成立，重试的语义才立得住。
 *
 * `owner` 是迁移开始时的作用域。切号之后不能把上一个账号的旧数据写进新账号的库：
 * 光靠世代守卫不够——切号会把连接置空，下一次 `getDB()` 直接开的是新账号的库，
 * 世代是新的，写会成功。所以入口、每个 store 写完、提交前各确认一次，
 * 变了就 abort 并抛 `ScopeMismatchError`。
 */
export const saveLegacyBundle = async (owner: string, bundle: LegacyBundle): Promise<void> => {
  const assertOwner = () => {
    if (currentScopeUserId() !== owner) {
      throw new ScopeMismatchError()
    }
  }
  assertOwner()
  const connection = await getDB()
  assertOwner()
  const tx = connection.transaction(
    ['sessions', 'sessionSummaries', 'files', 'memories', 'memoryProfile'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const summaries = tx.objectStore('sessionSummaries')
        for (const session of bundle.sessions) {
          await sessions.put(session)
          await summaries.put(storedSummary(session))
        }
        const files = tx.objectStore('files')
        for (const file of bundle.files) {
          await files.put(file)
        }
        assertOwner()
        const memories = tx.objectStore('memories')
        for (const entry of bundle.memories) {
          await memories.put(entry)
        }
        if (bundle.profile) {
          await tx.objectStore('memoryProfile').put(bundle.profile)
        }
        assertOwner()
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
