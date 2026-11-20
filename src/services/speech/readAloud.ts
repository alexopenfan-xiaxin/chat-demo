import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'
import { synthesize } from '../api/speech.js'
import { useSettings } from '../settings.js'
import { splitSpeechSegments } from './segments.js'
import { toSpeechText } from './speechText.js'

/**
 * 朗读：同一时间只读一条回复。
 *
 * 正文先转成朗读用纯文本（去 Markdown 标记），再按句子切段。
 * 第一段合成完立刻出声，后面几段并行请求（最多 3 段在途），
 * 播放用 AudioContext 的时钟排程，段与段首尾相接、中间不留空隙。
 * 状态：loading（已请求、未出声）→ playing → 结束回到 idle。
 */
export type ReadAloudStatus = 'idle' | 'loading' | 'playing'

type ReadAloudState = {
  /** 正在朗读的回复 id */
  messageId: string | null
  status: ReadAloudStatus
}

export const useReadAloud = create<ReadAloudState>(() => ({ messageId: null, status: 'idle' }))

/** 同时合成的段数：再多也只是排队等上游，反而占内存 */
const MAX_IN_FLIGHT = 3

/** 首段比当前时刻晚这么多开始，留出排程余量，避免 start 时间已经过去 */
const START_LEAD_SECONDS = 0.05

/** 单次朗读的总长度上限：分段后每段远小于服务端 5000 字，这里防的是整条回复太长 */
export const MAX_SPEECH_CHARS = 20000

/** 朗读在进入请求前就能判定的失败，自带提示文案的 key */
export class ReadAloudError extends Error {
  constructor(readonly key: 'ttsTooLong' | 'ttsEmpty') {
    super(key)
    this.name = 'ReadAloudError'
  }
}

type Session = {
  controller: AbortController
  context: AudioContext
  sources: Set<AudioBufferSourceNode>
}

let current: Session | null = null

const finish = (session: Session) => {
  if (current !== session) {
    return
  }
  for (const source of session.sources) {
    try {
      source.stop()
    } catch {
      // 已经结束的源再 stop 会抛错，忽略
    }
  }
  session.sources.clear()
  void session.context.close()
  current = null
  useReadAloud.setState({ messageId: null, status: 'idle' })
}

/** 停止当前朗读（再次点击、发送、停止生成、切换会话等场景调用） */
export const stopReadAloud = () => {
  if (!current) {
    return
  }
  const session = current
  session.controller.abort()
  finish(session)
}

export const describeReadAloudError = (error: unknown): TranslationMessage | string => {
  if (error instanceof ReadAloudError) {
    return { key: error.key }
  }
  if (error instanceof ApiError && error.kind === 'protocol') {
    return error.message
  }
  // 400 表示这段正文服务端无法合成，与其余失败区分开
  if (error instanceof ApiError && error.status === 400) {
    return { key: 'ttsUnavailable' }
  }
  // 413 是服务端的总长度上限；前端已经拦过，走到这里说明拦漏了，仍给明确文案
  if (error instanceof ApiError && error.status === 413) {
    return { key: 'ttsTooLong' }
  }
  switch (classifyApiError(error)) {
    case 'unauthorized':
      // 401 现在是「额度未开通／会话问题」，不再让用户去换 key
      return { key: 'replyNoCredits' }
    case 'insufficientBalance':
      return { key: 'insufficientBalance' }
    case 'rateLimited':
      return { key: 'rateLimited' }
    default:
      return { key: 'ttsFailed' }
  }
}

/**
 * 开始朗读一条回复的正文；同一条正在朗读时调用等于停止。
 * 必须在点击事件中同步调用：AudioContext 需要用户手势才能出声。
 */
export const toggleReadAloud = (
  messageId: string,
  markdown: string,
  onError: (error: unknown) => void
) => {
  const reading = useReadAloud.getState().messageId
  stopReadAloud()
  if (reading === messageId) {
    return
  }
  // 转写与切段都是纯计算，放在建 AudioContext 之前，失败时不用白开一路音频
  const spoken = toSpeechText(markdown)
  if (!spoken.trim()) {
    onError(new ReadAloudError('ttsEmpty'))
    return
  }
  if (spoken.length > MAX_SPEECH_CHARS) {
    onError(new ReadAloudError('ttsTooLong'))
    return
  }
  const segments = splitSpeechSegments(spoken)
  if (segments.length === 0) {
    onError(new ReadAloudError('ttsEmpty'))
    return
  }

  const controller = new AbortController()
  const context = new AudioContext()
  const session: Session = { controller, context, sources: new Set() }
  current = session
  useReadAloud.setState({ messageId, status: 'loading' })
  // 音色在开始朗读时读取，设置中切换后下一次朗读生效
  const { ttsVoice } = useSettings.getState()
  const { signal } = controller

  // 每段的合成 + 解码只发起一次，窗口内的后续段提前备好
  const tasks = new Map<number, Promise<AudioBuffer>>()
  const load = (index: number) => {
    const task = (async () => {
      const audio = await synthesize(segments[index], ttsVoice, signal)
      return context.decodeAudioData(audio)
    })()
    // 提前挂一个空 catch：取消后这些预取的请求会拒绝，但没人再去 await 它们
    task.catch(() => {})
    tasks.set(index, task)
    return task
  }

  void (async () => {
    /** 已经排上播放时钟的段数：预取窗口以它为基准往前推 */
    let running = 0
    let launched = 0
    let nextStartAt = 0
    const launch = () => {
      while (launched < segments.length && launched < running + MAX_IN_FLIGHT) {
        load(launched)
        launched += 1
      }
    }
    try {
      if (context.state === 'suspended') {
        await context.resume()
      }
      for (let index = 0; index < segments.length; index++) {
        launch()
        const task = tasks.get(index)
        if (!task) {
          throw new Error(`Speech segment ${index} was not scheduled`)
        }
        const buffer = await task
        tasks.delete(index)
        if (signal.aborted) {
          return
        }
        const startAt = Math.max(context.currentTime + START_LEAD_SECONDS, nextStartAt)
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        if (index === segments.length - 1) {
          source.onended = () => finish(session)
        }
        source.start(startAt)
        session.sources.add(source)
        source.addEventListener('ended', () => session.sources.delete(source))
        nextStartAt = startAt + buffer.duration
        running = index + 1
        // 第一段真正排上时钟之后才算「在放了」，之前仍然显示加载
        if (index === 0) {
          useReadAloud.setState({ status: 'playing' })
        }
        launch()
      }
    } catch (error) {
      if (!signal.aborted) {
        finish(session)
        onError(error)
      }
    }
  })()

  signal.addEventListener('abort', () => {
    tasks.clear()
    for (const source of session.sources) {
      try {
        source.stop()
      } catch {
        // 同上：已停止的源忽略
      }
    }
    session.sources.clear()
  })
}
