import { describe, expect, it } from 'vitest'

const { formatDownload } = await import('../src/components/memory/download-format')

describe('formatDownload', () => {
  it('按一位小数给 MB，中点分隔百分比', () => {
    expect(formatDownload(32_400_000, 64_500_000)).toBe('32.4 / 64.5 MB · 50%')
  })

  it('真到 100 才显示 100，差一点停在 99', () => {
    expect(formatDownload(64_499_000, 64_500_000)).toBe('64.5 / 64.5 MB · 99%')
    expect(formatDownload(64_500_000, 64_500_000)).toBe('64.5 / 64.5 MB · 100%')
  })

  it('超过 1000MB 换 GB', () => {
    expect(formatDownload(1_200_000_000, 1_400_000_000)).toBe('1.2 / 1.4 GB · 86%')
  })

  it('总量未知时不给数字，界面上只留那行字', () => {
    expect(formatDownload(1_000, 0)).toBeNull()
    expect(formatDownload(1_000, Number.NaN)).toBeNull()
  })

  it('已下载超过总量时按总量截断，不出现 101%', () => {
    expect(formatDownload(70_000_000, 64_500_000)).toBe('64.5 / 64.5 MB · 100%')
  })
})
