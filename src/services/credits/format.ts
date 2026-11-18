/**
 * 积分格式化：按量级分档，不能写死一位小数。
 *
 * 一位小数会把 0.02 舍成 0.0，用户看到的就是假的「没在消耗」——
 * 这和空进度条是同一个毛病的两个面。
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
  return (Math.round(value * 100) / 100).toFixed(2)
}

/** 百分比：不足 1% 写 <1%，写 0% 会和「已在消耗」自相矛盾 */
export const formatPercent = (ratio: number) =>
  ratio * 100 >= 1 ? `${Math.round(ratio * 100)}%` : '<1%'

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
