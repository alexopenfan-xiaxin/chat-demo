import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

/** 迁移本身被替换掉：这里只验「怎么跑、怎么重试、怎么报」，不重复测数据搬运 */
const migrate = vi.hoisted(() => ({
  calls: 0,
  /** 每次调用按顺序取一个结果 */
  results: [] as Array<Record<string, unknown>>,
  /** 调用那一刻 store 里的状态：浮层靠它显示「正在迁移」 */
  during: [] as Array<{ migrating: boolean }>,
  /** null 表示这台浏览器没有旧库 */
  inspect: { sessions: 1, memories: 0 } as null | { sessions: number; memories: number },
  summaries: [{ id: 's1', title: '旧会话', createdAt: 1, updatedAt: 1 }],
}))

const toasts = vi.hoisted(() => [] as unknown[])

vi.mock('../src/services/legacy-migrate', () => ({
  /** 前置探测：默认「有旧库」，单独一条用例覆盖「没有」 */
  inspectLegacy: async () => (migrate.inspect === null ? null : { sessions: 1, memories: 0 }),
  migrateLegacyOnce: async (
    _userId: string,
    onProgress?: (done: number, total: number) => void
  ) => {
    migrate.calls += 1
    const { useChatStore } = await import('../src/services/chat/store')
    migrate.during.push({ migrating: useChatStore.getState().migratingLegacy })
    onProgress?.(1, 3)
    return migrate.results.shift()
  },
}))

vi.mock('../src/services/chat/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/chat/db')>()
  return { ...actual, loadSessionSummaries: async () => migrate.summaries }
})

vi.mock('../src/components/base/toastState', () => ({
  showToast: (message: unknown) => toasts.push(message),
  useToast: () => ({ id: 0, message: null }),
}))

const installStorage = () => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  })
}

const { migrateLegacyHistory } = await import('../src/services/legacy-migrate-runner')
const { useChatStore } = await import('../src/services/chat/store')

const USER = '11111111-2222-3333-4444-555555555555'

beforeEach(() => {
  installStorage()
  migrate.calls = 0
  migrate.results = []
  migrate.during = []
  migrate.inspect = { sessions: 1, memories: 0 }
  toasts.length = 0
  useChatStore.setState({ migratingLegacy: false, legacyProgress: null, sessions: [] })
})

describe('登录后自动迁移旧库', () => {
  it('成功时刷新侧栏并提示条数', async () => {
    migrate.results = [{ status: 'done', stats: { sessions: 2, memories: 3 } }]

    await migrateLegacyHistory(USER)

    expect(migrate.calls).toBe(1)
    // 迁移期间置位，浮层才知道要出现
    expect(migrate.during[0]).toEqual({ migrating: true })
    expect(useChatStore.getState().migratingLegacy).toBe(false)
    expect(useChatStore.getState().legacyProgress).toBeNull()
    // 迁完立刻把旧会话刷进侧栏，不用刷新页面
    expect(useChatStore.getState().sessions.map((item) => item.id)).toEqual(['s1'])
    expect(toasts).toEqual([
      { key: 'legacyMigrated', params: { sessions: 2, memories: 3 } },
    ])
  })

  it('第一次失败时再试一次，第二次成功照常提示', async () => {
    migrate.results = [{ status: 'failed', error: 'quota' }, { status: 'done', stats: { sessions: 1, memories: 0 } }]

    await migrateLegacyHistory(USER)

    expect(migrate.calls).toBe(2)
    expect(toasts).toHaveLength(1)
    expect(useChatStore.getState().sessions).toHaveLength(1)
  })

  it('连续两次失败只记日志，不打扰用户', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    migrate.results = [
      { status: 'failed', error: 'quota' },
      { status: 'failed', error: 'quota' },
    ]

    await migrateLegacyHistory(USER)

    expect(migrate.calls).toBe(2)
    expect(toasts).toEqual([])
    expect(warn).toHaveBeenCalled()
    // 状态要收干净，否则浮层永远停在那里
    expect(useChatStore.getState().migratingLegacy).toBe(false)
    warn.mockRestore()
  })

  it('没有旧数据时静默结束，不提示也不刷新', async () => {
    migrate.results = [{ status: 'skipped', reason: 'no-legacy' }]

    await migrateLegacyHistory(USER)

    expect(migrate.calls).toBe(1)
    expect(toasts).toEqual([])
    expect(useChatStore.getState().sessions).toEqual([])
  })

  it('没有旧库时连迁移流程都不进', async () => {
    migrate.inspect = null
    await migrateLegacyHistory(USER)
    expect(migrate.calls).toBe(0)
    expect(useChatStore.getState().migratingLegacy).toBe(false)
    expect(toasts).toEqual([])
  })

  it('切号打断时既不重试也不提示', async () => {
    migrate.results = [{ status: 'aborted' }]
    await migrateLegacyHistory(USER)
    expect(migrate.calls).toBe(1)
    expect(toasts).toEqual([])
    expect(useChatStore.getState().legacyProgress).toBeNull()
  })

  it('已经在跑时不重入', async () => {
    useChatStore.setState({ migratingLegacy: true })
    await migrateLegacyHistory(USER)
    expect(migrate.calls).toBe(0)
  })
})
