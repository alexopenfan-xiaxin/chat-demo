import { describe, expect, it } from 'vitest'
import { barWidthPercent, creditTone, displayRatio, displayValue, formatCredits, formatPercent } from '../src/services/credits/format'

describe('formatCredits', () => {
  it('小于 10 保留两位，0.02 不能变成 0.0', () => {
    expect(formatCredits(0.02)).toBe('0.02')
    expect(formatCredits(9.98)).toBe('9.98')
  })

  it('正数被舍成 0 时写 <0.01，不写 0.00', () => {
    expect(formatCredits(0.004)).toBe('<0.01')
    expect(formatCredits(0.0002)).toBe('<0.01')
    expect(formatCredits(0)).toBe('0.00')
  })

  it('10 到 100 一位小数，整数不带 .0', () => {
    expect(formatCredits(12.7)).toBe('12.7')
    expect(formatCredits(10)).toBe('10')
    expect(formatCredits(99.94)).toBe('99.9')
  })

  it('<10 档舍完跨到 10 时交给上一档，不写 10.00', () => {
    expect(formatCredits(9.996)).toBe('10')
    expect(formatCredits(9.9998)).toBe('10')
    expect(formatCredits(99.996)).toBe('100')
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

  it('未满 100% 向下取整，别把 99.6% 写成 100%', () => {
    expect(formatPercent(0.01)).toBe('1%')
    expect(formatPercent(0.996)).toBe('99%')
    expect(formatPercent(0.9999)).toBe('99%')
    expect(formatPercent(1)).toBe('100%')
  })

  it('超额照实写', () => {
    expect(formatPercent(1.04)).toBe('104%')
  })
})

describe('barWidthPercent', () => {
  it('用量极小也至少画 3%，否则圆角把它吃成一个点', () => {
    expect(barWidthPercent(0.02, 10)).toBe(3)
  })

  it('正常用量按比例走，未满 100% 不画满', () => {
    expect(barWidthPercent(5, 10)).toBe(50)
    expect(barWidthPercent(996, 1000)).toBe(99)
    expect(barWidthPercent(10, 10)).toBe(100)
  })

  it('超额钳在 100%，0 用量不画', () => {
    expect(barWidthPercent(10.4, 10)).toBe(100)
    expect(barWidthPercent(0, 10)).toBe(0)
    expect(barWidthPercent(null, 10)).toBe(0)
    expect(barWidthPercent(1, null)).toBe(0)
    expect(barWidthPercent(1, 0)).toBe(0)
  })
})

describe('creditTone（阈值判定）', () => {
  it('剩余比例决定档位，0.2 刚好落 warn，超过就是品牌色', () => {
    expect(creditTone(10, 2)).toBe('warn')
    expect(creditTone(10, 2.001)).toBe('brand')
    expect(creditTone(10, 10)).toBe('brand')
  })

  it('用完与渲染成 <0.01 的微量都算 error', () => {
    expect(creditTone(10, 0)).toBe('error')
    expect(creditTone(10, 0.0002)).toBe('error')
    expect(creditTone(10, 0.006)).toBe('warn')
  })

  it('没有额度信息时不判错，回 brand', () => {
    expect(creditTone(null, 1)).toBe('brand')
    expect(creditTone(10, null)).toBe('brand')
    expect(creditTone(0, 0)).toBe('brand')
  })
})

describe('显示值口径（同屏不能自相矛盾）', () => {
  it('9.996 显示为 10，比例就是 100%，不会再配一句 99%', () => {
    expect(displayValue(9.996)).toBe(10)
    expect(displayRatio(9.996, 10)).toBe(1)
    expect(formatPercent(displayRatio(9.996, 10) as number)).toBe('100%')
    expect(barWidthPercent(9.996, 10)).toBe(100)
  })

  it('显示成两位小数的数字，比例也按两位算', () => {
    expect(displayRatio(0.03, 0.0301)).toBe(1)
    expect(displayRatio(0.02, 10)).toBe(0.002)
  })

  it('超额比例大于 1，条仍钳在 100%', () => {
    expect(formatPercent(displayRatio(10.4, 10) as number)).toBe('104%')
    expect(barWidthPercent(10.4, 10)).toBe(100)
  })
})
