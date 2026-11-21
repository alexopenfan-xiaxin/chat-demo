/**
 * 下载进度的数字排版：`32.4 / 64.5 MB · 50%`。
 *
 * 规则（11-21 与画眉定的）：
 * - 一位小数，≥ 1000MB 换 GB，同样一位小数；
 * - 百分比四舍五入，只有真到 100 才显示 100，别停在 99 又不动；
 * - 总量未知（`total <= 0`）时返回 null：宁可只显示左边那行字，也不显示 `0 / 0 MB`。
 */
const MB = 1_000_000

export const formatDownload = (done: number, total: number): string | null => {
  if (!Number.isFinite(total) || total <= 0) {
    return null
  }
  const clamped = Math.max(0, Math.min(done, total))
  const percent = clamped >= total ? 100 : Math.min(99, Math.round((clamped / total) * 100))
  // 单位只写一次：`32.4 / 64.5 MB · 50%`，两个数共用后面那个单位
  const [unit, scale] = total >= 1000 * MB ? ['GB', 1000 * MB] : ['MB', MB]
  return `${(clamped / scale).toFixed(1)} / ${(total / scale).toFixed(1)} ${unit} · ${percent}%`
}
