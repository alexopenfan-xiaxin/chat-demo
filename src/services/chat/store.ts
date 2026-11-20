import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { ApiError, streamMessage } from '../api/client.js'
import type { ChatModel, ToolExchangeItem } from '../api/types.js'
import { extractFileIds, getFileErrorCode, isRetryableApiError } from '../api/errors.js'
import { cancelUpload, describeUploadError, uploadAttachment, useUploads } from '../attachments.js'
import { useSettings } from '../settings.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import { serverTools } from '../memory/tools.js'
import {
  buildBlock,
  editMemory,
  loadProfile,
  markHits,
  saveMemory,
  searchMemory,
  updateProfile,
} from '../memory/store.js'
import { deleteMemoriesBySession } from './db.js'
import type { TextPart } from './types.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  settleReply,
  toRequestMessages,
} from './reply.js'
import { fetchBlocks, memoryActionBlocks, memoryFailureKey, searchBlocks } from './toolBlocks.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type ReplyBlock,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** deepseek-flash 同时支持深度思考与图片输入 */
const MODEL: ChatModel = 'deepseek-flash'
/** 所有生成请求统一携带的助手身份说明 */
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000


/** 工具调用最多连做 3 轮；模型还想调就收敛成一句说明，不静默丢弃 */
const MAX_TOOL_ROUNDS = 3

type ToolCall = { callId: string; name: string; arguments: string }

/**
 * 给用户看的过程文案：正在搜索/正在读取。
 *
 * 记忆工具只报动作、不读 content：用户明确要求「不用显示具体记了啥改了啥」，
 * 记忆正文也不该出现在这行瞬时状态里。
 */
const toolStatusText = (call: ToolCall): string => {
  if (call.name === 'memory_save') {
    return '正在记住…'
  }
  if (call.name === 'memory_edit') {
    return '正在更新记忆…'
  }
  if (call.name === 'memory_update_profile') {
    return '正在重写用户画像…'
  }
  let query = ''
  try {
    const args = JSON.parse(call.arguments) as { query?: unknown; url?: unknown }
    query = typeof args.query === 'string' ? args.query : typeof args.url === 'string' ? args.url : ''
  } catch {
    query = ''
  }
  const name = call.name === 'web_search' ? '正在搜索' : '正在读取网页'
  return query ? `${name}「${query}」…` : `${name}…`
}

/**
 * 执行一次工具调用，返回要回传给模型的字符串。
 *
 * 工具结果一律当作**不可信数据**：只有搜索结果的标题/链接/摘要或网页标题+正文，
 * 不带会话 token、用户邮箱、历史消息。失败也回一条 error 描述，让模型自己决定怎么说。
 */
const runToolCall = async (
  call: ToolCall,
  signal: AbortSignal,
  sessionId: string
): Promise<{ output: string; blocks: ReplyBlock[] }> => {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>
  } catch {
    args = {}
  }
  try {
    if (call.name === 'web_search') {
      const query = typeof args.query === 'string' ? args.query : ''
      const response = await fetch('/api/tools/search', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        signal,
      })
      const payload = (await response.json()) as {
        results?: Array<{ title: string; url: string; snippet: string }>
        error?: string
      }
      if (!response.ok) {
        return {
          output: JSON.stringify({ error: payload.error ?? '搜索失败' }),
          // 失败也留一张卡片：历史里的失败搜索同样会显示，用户需要知道它确实跑了
          blocks: searchBlocks(call.callId, query, [], true),
        }
      }
      const results = payload.results ?? []
      const lines = results.map(
        (item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.snippet}`
      )
      return {
        output: lines.length > 0 ? `搜索结果：\n${lines.join('\n\n')}` : '没有找到相关结果',
        blocks: searchBlocks(call.callId, query, results),
      }
    }
    if (call.name === 'read_url') {
      const url = typeof args.url === 'string' ? args.url : ''
      const response = await fetch(`/api/tools/fetch?url=${encodeURIComponent(url)}`, {
        credentials: 'same-origin',
        signal,
      })
      const payload = (await response.json()) as {
        title?: string
        content?: string
        truncated?: boolean
        error?: string
      }
      if (!response.ok) {
        return {
          output: JSON.stringify({ error: payload.error ?? '读取失败' }),
          blocks: fetchBlocks(call.callId, url, undefined, true),
        }
      }
      const head = payload.title ? `标题：${payload.title}\n` : ''
      const tail = payload.truncated ? '\n（正文过长，已截断）' : ''
      return {
        output: `${head}正文：\n${payload.content ?? ''}${tail}`,
        blocks: fetchBlocks(call.callId, url, { title: payload.title ?? null }),
      }
    }
    // 记忆工具：全部在本机执行，除了算向量不产生任何网络请求
    if (call.name === 'memory_update_profile') {
      const fullText = typeof args.full_text === 'string' ? args.full_text : ''
      const result = await updateProfile(fullText)
      return {
        output: JSON.stringify(result),
        blocks: memoryActionBlocks(call.callId, 'profile', result.ok, memoryFailureKey(result.message)),
      }
    }
    if (call.name === 'memory_save') {
      const content = typeof args.content === 'string' ? args.content : ''
      const tags = Array.isArray(args.tags)
        ? args.tags.filter((tag): tag is string => typeof tag === 'string')
        : undefined
      const result = await saveMemory({ content, tags, sessionId })
      return {
        output: JSON.stringify(result),
        blocks: memoryActionBlocks(call.callId, 'save', result.ok, memoryFailureKey(result.message)),
      }
    }
    if (call.name === 'memory_edit') {
      const id = typeof args.id === 'string' ? args.id : ''
      const content = typeof args.content === 'string' ? args.content : ''
      const tags = Array.isArray(args.tags)
        ? args.tags.filter((tag): tag is string => typeof tag === 'string')
        : undefined
      const result = await editMemory({ id, content, tags })
      return {
        output: JSON.stringify(result),
        blocks: memoryActionBlocks(call.callId, 'edit', result.ok, memoryFailureKey(result.message)),
      }
    }
    return { output: JSON.stringify({ error: `未知工具：${call.name}` }), blocks: [] }
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    return {
      output: JSON.stringify({ error: error instanceof Error ? error.message : '工具调用失败' }),
      blocks: [],
    }
  }
}

/**
 * 会话标题本地生成：上游的 `title` 事件从来没有出现过，指望它等于让侧栏永远显示「新对话」。
 *
 * 规则：先把换行和连续空白压成一个空格，中文按 24 字截，英文按词截到 40 字符，
 * 截断处落在半个词或标点上就清掉。只写一次——`session.title` 有值时不再覆盖，
 * 所以用户手动改过的名字不会在下一轮被改回去。
 */
/**
 * 首轮结束后请服务端用模型写一个更准的标题。
 *
 * 只在标题仍等于「本地截断」时替换：用户手改过的名字、或已经总结过的标题都不动。
 * 请求失败、超时、被限流都保留本地截断，用户完全无感。
 */
const summariseTitle = (sessionId: string, question: string) => {
  const local = deriveTitle(question)
  const session = getSession(sessionId)
  if (!local || !session || session.title !== local) {
    return
  }
  void fetch('/api/title', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload: unknown) => {
      const title =
        typeof payload === 'object' && payload !== null && typeof (payload as { title?: unknown }).title === 'string'
          ? (payload as { title: string }).title.trim()
          : ''
      if (!title) {
        return
      }
      updateSession(sessionId, (current) => (current.title === local ? { ...current, title } : current))
      persist(sessionId)
    })
    .catch(() => {
      // 保留本地截断
    })
}

const TITLE_CJK_LIMIT = 24
const TITLE_LATIN_LIMIT = 40
const hasCjk = (text: string) => /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)

export const deriveTitle = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) {
    return ''
  }
  let title: string
  if (hasCjk(flat)) {
    const chars = [...flat]
    title = chars.length > TITLE_CJK_LIMIT ? `${chars.slice(0, TITLE_CJK_LIMIT).join('')}…` : flat
  } else if (flat.length > TITLE_LATIN_LIMIT) {
    // 英文按词截：切到最后一个完整词，别留半个单词
    const cut = flat.slice(0, TITLE_LATIN_LIMIT)
    const boundary = cut.lastIndexOf(' ')
    title = `${(boundary > TITLE_LATIN_LIMIT / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`
  } else {
    title = flat
  }
  // 末尾标点（含截断前留下的逗号句号）统一清掉，再补省略号
  return title.replace(/[\s,.;:!?，。；：！？、·\-—]+(…)?$/u, (_, dots?: string) => (dots ? '…' : ''))
}

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
  /**
   * 导入进度：会话数已处理 / 总数（总数取不到时为 null）。
   * checking 是「还在数文件、没开始写」的阶段：这时候连总数都没有，
   * 浮层据此显示准备态 / 不确定态，而不是摆一个假的 0 / 0。
   */
  importProgress: {
    done: number
    total: number | null
    /** listing＝还在解析中央目录，checking＝校验格式，writing＝逐条写入 */
    stage?: 'checking' | 'listing' | 'writing' | 'committing' | 'rebuilding'
  } | null
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
  importProgress: null,
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<DeleteOutcome>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: MODEL,
    thinking,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        // 列表里没有这个会话（例如导入替换把它换掉了）：给出可重试的失败态。
        // 静默 return 会让界面永远停在「正在加载对话…」，既没有错误也没有重试按钮。
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/**
 * 等所有回复的收尾（落盘）完成。
 *
 * 有上限：只要有一个流因为任何原因没从 `streaming` 里摘掉，这一步就永远不返回，
 * `importingHistory` 会一直是 true，界面锁在「正在导入」上，只能刷新逃出去。
 * 挂起不抛异常，finally 兜不住，所以这里自己兜。
 */
const IDLE_TIMEOUT = 10_000
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    let timer = 0
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
    timer = setTimeout(() => {
      unsubscribe()
      // eslint-disable-next-line no-console
      console.warn('waitForIdle timed out, continuing', Object.keys(get().streaming))
      resolve()
    }, IDLE_TIMEOUT) as unknown as number
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (
  write: () => Promise<void>,
  /** 分阶段回调：提交与重建发生在替换内部，导入侧只能从这里拿到边界 */
  onPhase?: (phase: 'committing' | 'rebuilding') => void
): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      onPhase?.('committing')
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    onPhase?.('rebuilding')
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    // 只解除锁；清进度由调用方在写完成绩明细之后自己做 —— 先清进度会让浮层读不到结果，
    // 完成态就永远出不来
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    // 手动重命名优先级最高，本地标题本来就只在空标题时写一次
    void controller
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
/**
 * deleted 删除成功 · blocked 这条对话还在写（放弃删除）·
 * busy 有导入在做（不是生成中，别用同一句文案）· failed 存储出错
 */
export type DeleteOutcome = 'deleted' | 'blocked' | 'busy' | 'failed'

export const removeSession = (id: string): Promise<DeleteOutcome> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<DeleteOutcome> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return 'busy'
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return 'failed'
    }
    // waitForIdle 现在有上限，超时后流可能还在：这时候删掉它，
    // 那条流之后任何一次 persist 都会把会话写回来，用户看到「删了又回来」。
    // 宁可这次不删，让用户重试。
    if (Object.hasOwn(get().streaming, id)) {
      return 'blocked'
    }
    await db.deleteSession(id)
    // 会话没了，它产生的记忆条目一起清掉；手动新增的（sessionId 为 null）不受影响
    await deleteMemoriesBySession(id)
    if (epoch !== historyEpoch) {
      return 'deleted'
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return 'deleted'
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return 'failed'
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    // 只在还没有标题时写一次，用户改过的名字不会被覆盖
    title: session.title || deriveTitle(text),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? MODEL,
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) =>
              serverIds.has(file.id) ? { ...file, serverId: serverIds.get(file.id) ?? null } : file
            ),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId('', file)
      if (serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history).toReversed()) {
    for (const file of user.files) {
      if (!file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const serverId = await Promise.race([ensureServerId('', file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]))
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  // 记忆开关在整轮里取一次：关闭时不声明工具、不检索、不注入
  const memoryEnabled = useSettings.getState().memory
  let memoryBlock: string | null = null
  if (memoryEnabled) {
    // 每轮只算一次：工具往返可能发多次请求，块必须逐字节一致，否则前缀缓存全废
    const profile = await loadProfile()
    const hits = await searchMemory(request.question.content, sessionId)
    memoryBlock = buildBlock(profile, hits ?? [])
    if (hits && hits.length > 0) {
      void markHits(hits)
      // 回复上方要显示「参考了 N 条」：只留展示字段，向量不进消息库
      reply = {
        ...reply,
        recall: hits.map((hit) => ({
          id: hit.entry.id,
          content: hit.entry.content,
          score: Math.round(hit.score * 100) / 100,
          sessionId: hit.entry.sessionId,
          createdAt: hit.entry.createdAt,
        })),
      }
      updateReply(sessionId, reply)
    }
  }
  try {
    // 工具往返：模型发起调用 → 我们执行 → 结果回传 → 它接着说完，最多 MAX_TOOL_ROUNDS 轮
    const exchanges: ToolExchangeItem[] = []
    let toolRounds = 0
    for (;;) {
      const calls: ToolCall[] = []
      /** 本轮之前的块数：用来只回传这一轮模型自己说的话 */
      const blocksBefore = reply.blocks.length
      let roundDone = false
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      try {
        const prepared = await prepareFiles(sessionId, request, controller.signal)
        preparing = false
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const messages = toRequestMessages(
          prepared.history,
          prepared.question,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder,
          memoryBlock ?? undefined
        )
        const events = streamMessage(
          '',
          {
            model: initial.model ?? MODEL,
            system: SYSTEM_PROMPT,
            messages,
            thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
            safety_check: SAFETY_CHECK,
            tools: serverTools(initial.search ?? false, memoryEnabled),
            toolExchange: exchanges.length > 0 ? [...exchanges] : undefined,
          },
          controller.signal
        )
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          if (event.type === 'tool_call') {
            calls.push(event.call)
            continue
          }
          receivedContent ||= event.type === 'content_block_start'
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        roundDone = true
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
      if (!roundDone || calls.length === 0) {
        // 只有真的说完（没有待执行的工具调用）才收尾；工具轮中途收 done，
        // 会让历史里留下一条「已完成」但正文只有过程状态的回复。
        if (roundDone) {
          reply = settleReply(reply, 'done', Date.now())
          updateReply(sessionId, reply)
          persist(sessionId)
        }
        break
      }
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        // 到上限还在调：给一句明确说明，别让界面空着
        const notice: TextPart = {
          type: 'text',
          text: `工具调用已达上限（${MAX_TOOL_ROUNDS} 轮），先按现有结果回答。`,
          isTemplate: true,
        }
        reply = settleReply({ ...reply, blocks: [...reply.blocks, notice] }, 'done', Date.now())
        updateReply(sessionId, reply)
        persist(sessionId)
        break
      }
      toolRounds += 1
      // 过程状态：让用户知道在等什么，而不是对着空屏
      const status: TextPart = { type: 'text', text: calls.map(toolStatusText).join(' '), isTemplate: true }
      reply = { ...reply, blocks: [...reply.blocks, status], status: 'streaming' }
      updateReply(sessionId, reply)
      const outputs: string[] = []
      /** 工具结果的展示块（与历史导入同构），替换掉过程状态块画在回复里 */
      const runs: ReplyBlock[] = []
      let toolFailure: unknown = null
      try {
        for (const call of calls) {
          const run = await runToolCall(call, controller.signal, sessionId)
          outputs.push(run.output)
          runs.push(...run.blocks)
          if (controller.signal.aborted) {
            break
          }
        }
      } catch (error) {
        // runToolCall 只在停止时重抛，其余失败已经转成给模型看的错误 JSON
        toolFailure = error
      } finally {
        // 无论停止、失败还是正常结束，状态块都要摘掉：它被 persist 进历史就永久留在对话里。
        // 已完成的调用换成结果卡片，位置就是状态块原来所在的地方。
        reply = {
          ...reply,
          blocks: [...reply.blocks.filter((block) => block !== status), ...runs],
        }
      }
      if (controller.signal.aborted) {
        reply = settleReply(reply, 'stopped', Date.now())
        updateReply(sessionId, reply)
        persist(sessionId)
        break
      }
      if (toolFailure !== null) {
        reply = settleReply(reply, 'error', Date.now(), {
          kind: 'protocol',
          message: toolFailure instanceof Error ? toolFailure.message : String(toolFailure),
        })
        updateReply(sessionId, reply)
        persist(sessionId)
        break
      }
      // 把模型这一轮自己说的是带回给它：多轮搜索后它看不见上文会重复解释。
      // 顺序必须在 function_call 之前，否则就成了「先出结果再有调用」。
      const said = reply.blocks
        .slice(blocksBefore)
        .flatMap((block) => (block.type === 'text' && !block.isTemplate ? [block.text] : []))
        .join('\n\n')
        .trim()
      if (said) {
        exchanges.push({ role: 'assistant', content: said })
      }
      calls.forEach((call, index) => {
        exchanges.push({
          type: 'function_call',
          call_id: call.callId,
          name: call.name,
          arguments: call.arguments,
        })
        exchanges.push({ type: 'function_call_output', call_id: call.callId, output: outputs[index] ?? '' })
      })
      updateReply(sessionId, reply)
    }
  } finally {
    // 只有首轮（没有历史）才值得总结；后续轮次标题已经定下来了
    if (request.history.length === 0) {
      summariseTitle(sessionId, request.question.content)
    }
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}
