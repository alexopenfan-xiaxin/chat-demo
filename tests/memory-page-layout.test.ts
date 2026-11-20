import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 记忆空间的布局回归：这几条都是「三条数据时看不出来、塞满 200 条才炸」的东西，
 * 在浏览器里靠人工很难复现，所以直接对样式源码断言，挡住下次重做版式时被顺手删掉。
 */
const css = readFileSync(join(process.cwd(), 'src/components/memory/MemoryPage.module.css'), 'utf8')

const ruleBody = (selector: string): string => {
  const index = css.indexOf(`\n${selector} {`)
  if (index < 0) {
    throw new Error(`找不到规则 ${selector}`)
  }
  return css.slice(index, css.indexOf('}', index))
}

describe('记忆空间布局约束', () => {
  it('.page 必须占满父容器高度，否则长列表在 overflow:hidden 的外层里无处可滚', () => {
    const body = ruleBody('.page')
    expect(body).toContain('height: 100%')
    expect(body).toContain('overflow-y: auto')
    // 不能靠隐藏横向滚动条遮丑：那会把 scrollWidth 断言一起遮掉
    expect(body).not.toContain('overflow-x: hidden')
  })

  it('时间轴用容器级单条轨道，不是每条各画一段', () => {
    const body = ruleBody('.track')
    expect(body).toContain('position: absolute')
    expect(body).toContain('width: 1px')
  })

  it('离屏条目延后布局，并且估算值可在运行时被校准', () => {
    const body = ruleBody('.item')
    expect(body).toContain('content-visibility: auto')
    expect(body).toContain('contain-intrinsic-size: auto var(--entry-estimate')
  })

  it('打印时离屏条目必须恢复布局，否则打印是空白页', () => {
    expect(css).toContain('@media print')
    expect(css).toMatch(/@media print[\s\S]*?content-visibility: visible/)
  })
})
