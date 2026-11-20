import { describe, expect, it, vi } from 'vitest'

// attachments 顺带引入 api/client，那里读构建期注入的常量，测试里补一个空串（同源）
vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})
const { getFileViewAction, getFileViewType } = await import('../src/services/attachments')

/**
 * 附件动作只由后缀决定：光栅图与 PDF 用明确 MIME 在新标签打开，
 * SVG 与其他文件一律下载。这组分支决定了 blob 会不会被浏览器当文档解析。
 */
describe('附件展示类型（按后缀判定）', () => {
  it('常见光栅图给出具体 MIME', () => {
    expect(getFileViewType('a.png')).toBe('image/png')
    expect(getFileViewType('a.jpg')).toBe('image/jpeg')
    expect(getFileViewType('a.jpeg')).toBe('image/jpeg')
    expect(getFileViewType('a.gif')).toBe('image/gif')
    expect(getFileViewType('a.webp')).toBe('image/webp')
  })

  it('上游补充的图片后缀也认', () => {
    expect(getFileViewType('a.apng')).toBe('image/png')
    expect(getFileViewType('a.avif')).toBe('image/avif')
    expect(getFileViewType('a.tiff')).toBe('image/tiff')
    expect(getFileViewType('a.heic')).toBe('image/heic')
    expect(getFileViewType('a.ico')).toBe('image/x-icon')
  })

  it('SVG 与 PDF 各有明确类型', () => {
    expect(getFileViewType('a.svg')).toBe('image/svg+xml')
    expect(getFileViewType('a.pdf')).toBe('application/pdf')
  })

  it('大写后缀同样识别，未知后缀与无后缀给空串', () => {
    expect(getFileViewType('A.PNG')).toBe('image/png')
    expect(getFileViewType('a.txt')).toBe('')
    expect(getFileViewType('a')).toBe('')
    expect(getFileViewType('.png')).toBe('')
  })
})

describe('附件打开方式', () => {
  it('SVG 只能下载，即使它是图片', () => {
    const action = getFileViewAction('image/svg+xml', 'logo.svg')
    expect(action).toEqual({ download: 'logo.svg' })
    expect('target' in action).toBe(false)
  })

  it('光栅图在新标签打开', () => {
    expect(getFileViewAction('image/png', 'a.png')).toEqual({ target: '_blank', rel: 'noreferrer' })
    expect(getFileViewAction('image/jpeg', 'a.jpg')).toEqual({
      target: '_blank',
      rel: 'noreferrer',
    })
  })

  it('PDF 也在新标签打开', () => {
    expect(getFileViewAction('application/pdf', 'a.pdf')).toEqual({
      target: '_blank',
      rel: 'noreferrer',
    })
  })

  it('其它文件按原文件名下载', () => {
    expect(getFileViewAction('', 'a.zip')).toEqual({ download: 'a.zip' })
    expect(getFileViewAction('text/plain', 'a.txt')).toEqual({ download: 'a.txt' })
    expect(getFileViewAction('', 'a.html')).toEqual({ download: 'a.html' })
  })
})
