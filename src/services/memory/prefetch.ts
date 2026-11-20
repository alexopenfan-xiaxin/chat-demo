import { embedTexts, useMemoryStatus } from './api.js'
import { useSettings } from '../settings.js'

/**
 * 向量预取：在用户打字停顿时先把这一句的向量算好。
 *
 * 为什么需要：这一跳经隧道实测 p50 1.4 秒，而发送前的召回预算只有 800ms，
 * 现算永远赶不上。把计算挪进打字间隙，发送时直接命中缓存，召回就是本地点积。
 * 没命中则用最后算过的一条向量兜底——**绝不阻塞发送**。
 *
 * 失败一律静默：预取只是优化，出任何问题都退回原来的路径。
 */

/** 停顿多久算「这一句想好了」 */
export const PREFETCH_IDLE_MS = 400
/** 两次真正发出的预取至少隔这么久，连续停顿不该把配额打光 */
const PREFETCH_MIN_INTERVAL_MS = 1200
/** 缓存有效期与条数上限：一屏对话内的句子够用就行 */
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_LIMIT = 40
/** 一两个字跟记忆无关，不必花一次调用 */
const MIN_CHARS = 2
/** 预取不在用户等待路径上，可以等久一点 */
const PREFETCH_TIMEOUT_MS = 6000

export type QueryVector = { vec: Float32Array; dim: number }

type Cached = QueryVector & { at: number }

const cache = new Map<string, Cached>()
/** 最后一条算成功的向量：预取没赶上时用它兜底，语义上最接近「用户最近在想的事」 */
let lastQuery: QueryVector | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let lastSentAt = 0
/** 正在算的文本：同一句不重复发 */
const inflight = new Set<string>()

const keyOf = (text: string) => text.trim()

const remember = (text: string, values: readonly number[], dim: number, now = Date.now()) => {
  const key = keyOf(text)
  if (!key) {
    return
  }
  if (cache.size >= CACHE_LIMIT) {
    for (const [cached, entry] of cache) {
      if (now - entry.at > CACHE_TTL_MS) {
        cache.delete(cached)
      }
    }
  }
  while (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    cache.delete(oldest)
  }
  cache.set(key, { vec: Float32Array.from(values), dim, at: now })
}

/** 取这句话预先算好的向量；过期的不算命中 */
export const takeVector = (text: string, now = Date.now()): QueryVector | null => {
  const entry = cache.get(keyOf(text))
  if (!entry) {
    return null
  }
  if (now - entry.at > CACHE_TTL_MS) {
    cache.delete(keyOf(text))
    return null
  }
  return { vec: entry.vec, dim: entry.dim }
}

/** 兜底向量：预取没赶上时用，可能和当前这句无关，阈值会把它挡在召回之外 */
export const fallbackVector = (): QueryVector | null => lastQuery

export const setLastQuery = (vec: Float32Array, dim: number): void => {
  lastQuery = { vec, dim }
}

/** 写入侧拿到向量时顺手缓存，减少重复计算 */
export const rememberVector = (text: string, values: readonly number[], dim: number): void => {
  remember(text, values, dim)
}

/**
 * 输入变化时调用：自带 400ms 静默去抖，组件只需要在 onChange 里喊一声。
 * 已有缓存、正在算、太短、开关关掉——都不发请求。
 */
export const prefetchInput = (text: string): void => {
  const value = keyOf(text)
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if ([...value].length < MIN_CHARS) {
    return
  }
  if (cache.has(value) || inflight.has(value)) {
    return
  }
  timer = setTimeout(() => {
    timer = null
    void run(value)
  }, PREFETCH_IDLE_MS)
}

const schedule = (value: string, delay: number) => {
  if (timer !== null) {
    clearTimeout(timer)
  }
  timer = setTimeout(() => {
    timer = null
    void run(value)
  }, delay)
}

const run = async (value: string): Promise<void> => {
  // 关掉记忆就不该有后台请求：设置页一关，后续停顿全部安静
  if (!useSettings.getState().memory || useMemoryStatus.getState().available === false) {
    return
  }
  const now = Date.now()
  const waited = now - lastSentAt
  if (waited < PREFETCH_MIN_INTERVAL_MS) {
    // 不是丢弃，是挪到额度恢复之后再发
    schedule(value, PREFETCH_MIN_INTERVAL_MS - waited)
    return
  }
  lastSentAt = now
  inflight.add(value)
  try {
    const result = await embedTexts([value], PREFETCH_TIMEOUT_MS)
    remember(value, result.vectors[0], result.dim)
    setLastQuery(Float32Array.from(result.vectors[0]), result.dim)
  } catch {
    // 预取失败不影响任何事：发送时退回现算，再不行就只带画像
  } finally {
    inflight.delete(value)
  }
}

/** 测试与登出时清空，避免跨账号残留 */
export const resetPrefetch = (): void => {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  cache.clear()
  inflight.clear()
  lastQuery = null
  lastSentAt = 0
}
