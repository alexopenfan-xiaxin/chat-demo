import { create } from 'zustand'
import * as db from '../chat/db.js'
import { EMBEDDINGS_MODEL, embedTextsAs } from './api.js'

/**
 * 记忆索引升级：把本地条目的向量从一个模型重算成另一个。
 *
 * 为什么必须重算：qwen 是 768 维、bge-m3 是 1024 维，两个向量空间不通用，
 * 跨模型算出来的余弦是没有意义的数字。所以条目里存了 `model`，召回只跟同模型的条目比；
 * 换了模型之后，旧条目在重算完成前一律静默跳过（不报错、不影响聊天），
 * 这里负责把它们分批补算回来。
 *
 * 节奏：每批 8 条（服务端单次上限）、批间隔 3 秒，失败的那批保留旧模型等下一轮，
 * 绝不因为一条算不出来就把整轮卡死。开记忆且浏览器空闲时才跑。
 */

/** 每批条数与间隔：8 是 `/api/embed` 的单次上限，3 秒是别把探针额度打满 */
export const REINDEX_BATCH = 8
export const REINDEX_INTERVAL_MS = 3000
/** 一批 8 条还要算推理，给 8 秒 */
export const REINDEX_TIMEOUT_MS = 8000
/** 探针用的固定短语：只为拿到目标模型的 `model` 标识，向量本身不用 */
const PROBE_TEXT = '索引升级'

export type ReindexState = {
  running: boolean
  done: number
  total: number
  /** 目标模型标识（服务端回的 model 字符串），没有时为空 */
  model: string
}

export const useReindex = create<ReindexState>(() => ({ running: false, done: 0, total: 0, model: '' }))

const toVector = (values: readonly number[]): Float32Array => Float32Array.from(values)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

let inFlight: Promise<void> | null = null

/**
 * 跑一轮升级。已经在跑时返回同一个 Promise，重复调用不会叠加任务。
 *
 * 只给「开关已经切到别的模型」时用：默认讯飞那条不需要迁移，
 * 直接返回，连一次网络请求都不发。
 */
export const startReindex = (): Promise<void> => {
  if (EMBEDDINGS_MODEL === 'qwen') {
    return Promise.resolve()
  }
  if (inFlight) {
    return inFlight
  }
  inFlight = runOnce().finally(() => {
    inFlight = null
  })
  return inFlight
}

/** 只跑一轮：拿到目标模型标识 → 筛出旧模型条目 → 分批重算 */
const runOnce = async (): Promise<void> => {
  let label = ''
  try {
    const probe = await embedTextsAs('cf-bge-m3', [PROBE_TEXT], REINDEX_TIMEOUT_MS)
    label = probe.model
  } catch {
    // 模型这一跳都不通就别开张：等下一轮，别把条目改成半成品
    return
  }
  if (!label || label === '') {
    return
  }
  const entries = await db.loadMemories()
  const stale = entries.filter((entry) => entry.model !== label)
  if (stale.length === 0) {
    return
  }
  useReindex.setState({ running: true, done: 0, total: stale.length, model: label })
  for (let start = 0; start < stale.length; start += REINDEX_BATCH) {
    const batch = stale.slice(start, start + REINDEX_BATCH)
    try {
      const result = await embedTextsAs(
        'cf-bge-m3',
        batch.map((entry) => entry.content),
        REINDEX_TIMEOUT_MS
      )
      if (result.vectors.length !== batch.length) {
        throw new Error('mismatched vectors')
      }
      await Promise.all(
        batch.map((entry, index) =>
          db.putMemory({
            ...entry,
            vec: toVector(result.vectors[index]),
            dim: result.dim,
            model: result.model,
          })
        )
      )
      useReindex.setState((state) => ({ ...state, done: state.done + batch.length }))
    } catch {
      // 这一批算不出来：条目保留旧模型，召回时继续跳过，下一轮再试
    }
    if (start + REINDEX_BATCH < stale.length) {
      await sleep(REINDEX_INTERVAL_MS)
    }
  }
  useReindex.setState((state) => ({ ...state, running: false }))
}
