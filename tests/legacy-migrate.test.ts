import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { deleteDB, openDB } from 'idb'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

const installStorage = () => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  })
  return store
}

const db = await import('../src/services/chat/db')
const legacy = await import('../src/services/legacy-migrate')

const A = '11111111-2222-3333-4444-555555555555'

const session = (id: string, title: string) => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
  messages: [
    { id: `${id}-m1`, role: 'user' as const, content: '你好', files: [], createdAt: 1 },
    {
      id: `${id}-m2`,
      role: 'assistant' as const,
      content: '你好，有什么可以帮你',
      createdAt: 2,
    },
  ],
  compaction: null,
})

const memory = (id: string, content: string) => ({
  id,
  content,
  tags: [],
  vec: new Float32Array([1, 0]),
  dim: 2,
  model: 'test',
  createdAt: 1,
  updatedAt: 1,
  prevContent: null,
  sessionId: null,
  hitCount: 0,
  lastUsedAt: null,
})

/** 造一个分区前的旧库：库名 `chat-demo`，结构与现版本一致 */
const seedLegacy = async (input: {
  sessions?: ReturnType<typeof session>[]
  memories?: ReturnType<typeof memory>[]
  profile?: string
  report?: string
  files?: { id: string; blob: Blob }[]
}) => {
  const handle = await openDB('chat-demo', 1, {
    upgrade(upgradeDb) {
      upgradeDb.createObjectStore('sessions', { keyPath: 'id' })
      upgradeDb.createObjectStore('memories', { keyPath: 'id' })
      upgradeDb.createObjectStore('memoryProfile', { keyPath: 'id' })
      upgradeDb.createObjectStore('files', { keyPath: 'id' })
    },
  })
  for (const item of input.sessions ?? []) {
    await handle.put('sessions', item)
  }
  for (const item of input.memories ?? []) {
    await handle.put('memories', item)
  }
  if (input.profile !== undefined) {
    await handle.put('memoryProfile', { id: 'profile', text: input.profile, updatedAt: 1 })
  }
  for (const file of input.files ?? []) {
    await handle.put('files', file)
  }
  if (input.report !== undefined) {
    localStorage.setItem('chat-demo:import-report', input.report)
  }
  handle.close()
}

describe('旧库一次性迁移', () => {
  let store: Map<string, string>

  beforeEach(async () => {
    store = installStorage()
    await db.setStorageScope(null)
    await deleteDB('chat-demo')
    await deleteDB(db.dbNameFor(A))
  })

  it('把旧库的会话、记忆、画像复制进当前账号的库，旧库原样留着', async () => {
    await seedLegacy({
      sessions: [session('s1', '高铁'), session('s2', '代码')],
      memories: [memory('m1', '偏好短句'), memory('m2', '在写 Rust')],
      profile: '在做 ds-chat',
      report: '[{"outcome":"ok"}]',
    })
    await db.setStorageScope(A)

    const seen: number[] = []
    const result = await legacy.migrateLegacyOnce(A, (done) => seen.push(done))

    expect(result).toEqual({ status: 'done', stats: { sessions: 2, memories: 2 } })
    expect(await db.loadSessionSummaries()).toHaveLength(2)
    expect((await db.loadSession('s1'))?.messages).toHaveLength(2)
    expect(await db.loadMemories()).toHaveLength(2)
    expect((await db.loadMemoryProfile())?.text).toBe('在做 ds-chat')
    // 导入报告跟着账号分键
    expect(localStorage.getItem('chat-demo:import-report:' + A)).toBe('[{"outcome":"ok"}]')
    // 进度是一次一条地报上去的，浮层才有东西可画
    expect(seen.at(0)).toBe(0)
    expect(seen.at(-1)).toBe(5)

    // 旧库不动：数量与内容都还在
    const old = await openDB('chat-demo')
    expect(await old.count('sessions')).toBe(2)
    expect(await old.count('memories')).toBe(2)
    old.close()
    // 标记写下来了
    expect(localStorage.getItem(legacy.LEGACY_MIGRATED_FLAG)).toBeTruthy()
  })

  it('迁过一次就不再问，也不重复写', async () => {
    await seedLegacy({ sessions: [session('s1', '高铁')] })
    await db.setStorageScope(A)
    expect(await legacy.migrateLegacyOnce(A)).toMatchObject({ status: 'done' })

    expect(await legacy.migrateLegacyOnce(A)).toEqual({ status: 'skipped', reason: 'migrated' })
    expect(await db.loadSessionSummaries()).toHaveLength(1)
  })

  it('当前账号库里已经有东西时不合并，也不写标记', async () => {
    await seedLegacy({ sessions: [session('s1', '旧会话')] })
    await db.setStorageScope(A)
    await db.saveSession(session('s-new', '新会话') as never)

    expect(await legacy.migrateLegacyOnce(A)).toEqual({
      status: 'skipped',
      reason: 'target-not-empty',
    })
    expect(await db.loadSessionSummaries()).toHaveLength(1)
    expect(localStorage.getItem(legacy.LEGACY_MIGRATED_FLAG)).toBeNull()
  })

  it('没有旧库、或旧库是空的，都按没有数据跳过', async () => {
    await db.setStorageScope(A)
    expect(await legacy.inspectLegacy()).toBeNull()
    expect(await legacy.migrateLegacyOnce(A)).toEqual({ status: 'skipped', reason: 'no-legacy' })

    await seedLegacy({})
    expect(await legacy.inspectLegacy()).toBeNull()
    expect(await legacy.migrateLegacyOnce(A)).toEqual({ status: 'skipped', reason: 'no-legacy' })
  })

  it('会话引用的附件原件跟着一起搬，孤立文件不复制', async () => {
    const withFile = session('s1', '带图')
    withFile.messages[0].files = [
      {
        id: 'f1',
        serverId: null,
        name: 'a.png',
        size: 3,
        isImage: true,
        mimeType: 'image/png',
      },
    ] as never
    await seedLegacy({
      sessions: [withFile],
      files: [
        { id: 'f1', blob: new Blob(['png']) },
        { id: 'f2', blob: new Blob(['orphan']) },
      ],
    })
    await db.setStorageScope(A)
    expect(await legacy.migrateLegacyOnce(A)).toMatchObject({ status: 'done' })

    // 历史图片还能打开
    expect(await db.loadFile('f1')).toBeDefined()
    // 没人引用的旧文件不跟着复制，省一份空间
    expect(await db.loadFile('f2')).toBeUndefined()
  })

  it('旧库只有记忆没有会话时也能迁', async () => {
    await seedLegacy({ memories: [memory('m1', '偏好短句')] })
    await db.setStorageScope(A)
    expect(await legacy.inspectLegacy()).toEqual({ sessions: 0, memories: 1 })
    expect(await legacy.migrateLegacyOnce(A)).toEqual({
      status: 'done',
      stats: { sessions: 0, memories: 1 },
    })
    expect(await db.loadMemories()).toHaveLength(1)
  })
})
