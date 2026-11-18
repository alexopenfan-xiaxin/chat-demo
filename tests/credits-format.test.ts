import { describe, expect, it } from 'vitest'
import { barWidthPercent, formatCredits, formatPercent } from '../src/services/credits/format'

describe('formatCredits', () => {
  it('小于 10 保留两位，0.02 不能变成 0.0', () => {
    expect(formatCredits(0.02)).toBe('0.02')
    expect(formatCredits(9.98)).toBe('9.98')
    expect(formatCredits(0.004)).toBe('0.00')
  })

  it('10 到 100 一位小数，整数不带 .0', () => {
    expect(formatCredits(12.7)).toBe('12.7')
    expect(formatCredits(10)).toBe('10')
    expect(formatCredits(99.94)).toBe('99.9')
  })

  it('100 以上取整', () => {
    expect(formatCredits(87)).toBe('87')
    expect(formatCredits(123.6)).toBe('124')
  })
})

describe('formatPercent', () => {
  it('不足 1% 写 <1%，不写 0%', () => {
    expect(formatPercent(0.002)).toBe('<1%')
    expect(formatPercent(0.0099)).toBe('<1%')
  })

  it('超过 1% 四舍五入成整数百分比，超额照实写', () => {
    expect(formatPercent(0.01)).toBe('1%')
    expect(formatPercent(0.996)).toBe('100%')
    expect(formatPercent(1.04)).toBe('104%')
  })
})

describe('barWidthPercent', () => {
  it('用量极小也至少画 3%，否则圆角把它吃成一个点', () => {
    expect(barWidthPercent(0.02, 10)).toBe(3)
  })

  it('正常用量按比例走', () => {
    expect(barWidthPercent(5, 10)).toBe(50)
    expect(barWidthPercent(9.96, 10)).toBe(100)
  })

  it('超额钳在 100%，0 用量不画', () => {
    expect(barWidthPercent(10.4, 10)).toBe(100)
    expect(barWidthPercent(0, 10)).toBe(0)
    expect(barWidthPercent(null, 10)).toBe(0)
    expect(barWidthPercent(1, null)).toBe(0)
    expect(barWidthPercent(1, 0)).toBe(0)
  })
})
