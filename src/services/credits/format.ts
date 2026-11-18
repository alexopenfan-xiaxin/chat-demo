/** 渲染成两位小数后为 0 的阈值：显示 <0.01 时它实际上已经用不了一次请求 */
const SPENT_EPSILON = 0.005

/**
 * 积分格式化：按量级分档，不能写死一位小数。
 *
 * 一位小数会把 0.02 舍成 0.0，用户看到的就是假的「没在消耗」——
 * 这和空进度条是同一个毛病的两个面。小于 0.01 也不写 0.00，写 <0.01：
 * 「还有 0.0002」和「一分都不剩」在卡片上必须是两种说法。
 *
 * >= 100 整数（87）· 10–100 一位小数（12.7）· < 10 两位小数（9.98 / 0.02）
 */
export const formatCredits = (value: number) => {
  const abs = Math.abs(value)
  if (abs >= 100) {
    return String(Math.round(value))
  }
  if (abs >= 10) {
    const one = value.toFixed(1)
    return one.endsWith('.0') ? one.slice(0, -2) : one
  }
  const two = Math.round(value * 100) / 100
  // 正数被舍成 0 时不能说 0.00：那正是「假 0」本身
  if (two === 0 && value > 0) {
    return '<0.01'
  }
  return two.toFixed(2)
}

/**
 * 百分比：不足 1% 写 <1%；未满 100% 时向下取整，避免 99.6% 被写成 100%
 * 而剩余积分还有一点（条 100% + 文案 100% + 没用完，是又一处自相矛盾）。
 */
export const formatPercent = (ratio: number) => {
  const percent = ratio * 100
  if (percent < 1) {
    return '<1%'
  }
  return `${percent >= 100 ? Math.round(percent) : Math.floor(percent)}%`
}

/**
 * 进度条宽度（百分比）：只要 used > 0 至少画 3%，最多 100%。
 *
 * 6px 高、圆角 999 的条在宽度小于 6px 时两端圆角会把它吃成一个小圆点，
 * 读起来像标记而不是进度；3%（332px 轨道约 10px）刚好是完整的短胶囊。
 */
export const barWidthPercent = (used: number | null, limit: number | null) => {
  if (used === null || limit === null || limit <= 0 || used <= 0) {
    return 0
  }
  return Math.round(Math.max(0.03, Math.min(1, used / limit)) * 100)
}

export type CreditTone = 'brand' | 'warn' | 'error'

/**
 * 条的警示色按**剩余比例**判断，不用 `1 - used/limit`：
 * 超额时 used > limit，那个式子会算出负数，落进任何一档都可能判错。
 *
 * 剩余 > 20% 品牌色 · 0–20% warn · 用完（含渲染成 <0.01 的微量）error。
 * 0 才是质变点，0–5% 不再单开一档。
 */
export const creditTone = (limit: number | null, remaining: number | null): CreditTone => {
  if (limit === null || limit <= 0 || remaining === null) {
    return 'brand'
  }
  if (remaining <= 0 || remaining < SPENT_EPSILON) {
    return 'error'
  }
  return remaining / limit <= 0.2 ? 'warn' : 'brand'
}
