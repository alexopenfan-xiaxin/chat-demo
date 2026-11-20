import { describe, expect, it } from 'vitest'
import { createProgressReporter, type ImportProgressValue } from '../src/services/chat/history/progress'

/** 可控时钟 + 收集发出的进度 */
const setup = () => {
  let time = 0
  const sent: ImportProgressValue[] = []
  const report = createProgressReporter((value) => sent.push(value), () => time)
  const advance = (ms: number) => {
    time += ms
  }
  return { report, sent, advance }
}

describe('导入进度节流', () => {
  it('第一次一定发出', () => {
    const { report, sent } = setup()
    report(0, 76, 'writing')
    expect(sent).toHaveLength(1)
  })

  it('50ms 内的相邻更新被合并，7 次只发 1 次', () => {
    const { report, sent } = setup()
    report(0, 400, 'writing')
    for (let index = 1; index <= 6; index++) {
      report(index, 400, 'writing')
    }
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ done: 0, total: 400, stage: 'writing' })
  })

  it('时间到了但进度没走够 5% 也不发：两个条件取更晚的那个', () => {
    const { report, sent, advance } = setup()
    report(0, 400, 'writing')
    advance(60)
    report(1, 400, 'writing')
    expect(sent).toHaveLength(1)
    advance(60)
    report(20, 400, 'writing')
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({ done: 20, total: 400, stage: 'writing' })
  })

  it('等了 250ms 兜底发一次，不让数字卡死', () => {
    const { report, sent, advance } = setup()
    report(0, 400, 'writing')
    advance(249)
    report(1, 400, 'writing')
    expect(sent).toHaveLength(1)
    advance(2)
    report(2, 400, 'writing')
    expect(sent[sent.length - 1]).toEqual({ done: 2, total: 400, stage: 'writing' })
  })

  it('完成一定立刻发出，不等窗口', () => {
    const { report, sent } = setup()
    report(74, 76, 'writing')
    report(75, 76, 'writing')
    expect(sent).toHaveLength(1)
    report(76, 76, 'writing')
    expect(sent[sent.length - 1]).toEqual({ done: 76, total: 76, stage: 'writing' })
  })

  it('force 用于首帧与收尾', () => {
    const { report, sent } = setup()
    report(0, null, 'listing', true)
    report(3, null, 'listing')
    expect(sent).toHaveLength(1)
    report(4, null, 'listing', true)
    expect(sent).toHaveLength(2)
  })

  it('总数未知时只按时间节流，不会因为算不出比例就一次都不发', () => {
    const { report, sent, advance } = setup()
    report(0, null, 'listing', true)
    advance(60)
    report(32, null, 'listing')
    expect(sent).toHaveLength(2)
  })

  it('发出的数字单调递增，不会回退', () => {
    const { report, sent, advance } = setup()
    report(0, 76, 'writing')
    for (let index = 1; index <= 76; index++) {
      advance(10)
      report(index, 76, 'writing')
    }
    const dones = sent.map((value) => value.done)
    expect([...dones].sort((a, b) => a - b)).toEqual(dones)
    expect(dones[dones.length - 1]).toBe(76)
  })
})
