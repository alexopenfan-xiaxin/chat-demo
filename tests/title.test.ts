import { describe, expect, it } from 'vitest'
import { sanitiseTitle } from '../functions/api/title'

describe('sanitiseTitle', () => {
  it('剥掉模型加的引号和末尾标点', () => {
    expect(sanitiseTitle('「异步改造及阻塞原因解析。」')).toBe('异步改造及阻塞原因解析')
    expect(sanitiseTitle('"Async refactor plan."')).toBe('Async refactor plan')
  })

  it('压掉多余空白', () => {
    expect(sanitiseTitle('  异步  改造\n与阻塞  ')).toBe('异步 改造 与阻塞')
  })

  it('中文超过 24 字硬截断', () => {
    const long = '一'.repeat(40)
    expect([...sanitiseTitle(long)]).toHaveLength(24)
  })

  it('空输出就是空标题，让前端保留本地截断', () => {
    expect(sanitiseTitle('   ')).toBe('')
    expect(sanitiseTitle('""')).toBe('')
  })
})
