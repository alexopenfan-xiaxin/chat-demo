/** 导入的五个阶段：读目录 → 校验 → 逐条写入 → 提交事务 → 重建列表 */
export type ImportPhase = 'checking' | 'listing' | 'writing' | 'committing' | 'rebuilding'

export type ImportProgressValue = {
  done: number
  total: number | null
  stage: ImportPhase
}

/** 两次刷新之间的最小间隔 */
const THROTTLE_MS = 50
/** 进度至少前进这么多才刷新：76 个会话约 4 个一刷，一整套只有十几次 */
const THROTTLE_RATIO_STEP = 0.05
/** 兜底：再慢也要在这个间隔内动一次，免得数字看起来卡死 */
const THROTTLE_MAX_MS = 250

/**
 * 导入进度节流：每处理一个会话就 setState 一次会把主线程交给 React 渲染几十次，
 * 而用户看不出 47/76 与 48/76 的区别。规则是下面的任意一条先满足就发：
 *
 * - 距上次发出超过 50ms **且** 进度比上次多走了 5%（两者都满足才发，取更晚的那个）；
 * - 或者已经等了 250ms：再慢也动一次，免得数字看起来卡死；
 * - 第一次、完成（done === total）和收尾，强制发出。
 *
 * 完成为什么必须强制：最后一帧卡在 74/76 然后浮层直接消失，比不节流还怪。
 */
export const createProgressReporter = (
  emit: (value: ImportProgressValue) => void,
  now: () => number = () => Date.now()
) => {
  let lastAt = Number.NEGATIVE_INFINITY
  let lastRatio = -1
  let emitted = 0
  return (done: number, total: number | null, stage: ImportPhase, force = false): void => {
    const at = now()
    const ratio = total !== null && total > 0 ? done / total : null
    const finished = total !== null && done >= total
    const waited = at - lastAt
    const moved = ratio === null || ratio - lastRatio >= THROTTLE_RATIO_STEP
    const due =
      force ||
      finished ||
      emitted === 0 ||
      (waited >= THROTTLE_MS && moved) ||
      waited >= THROTTLE_MAX_MS
    if (!due) {
      return
    }
    emitted += 1
    lastAt = at
    if (ratio !== null) {
      lastRatio = ratio
    }
    emit({ done, total, stage })
  }
}
