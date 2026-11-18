import { describe, expect, it } from 'vitest'
import { indexMatchesSessions } from '../src/services/chat/history/importArchive'

const ids = (...list: string[]) => new Set(list)

describe('indexMatchesSessions（索引与会话一一对应）', () => {
  it('完全一致时通过', () => {
    expect(indexMatchesSessions([{ id: 'a' }, { id: 'b' }], ids('a', 'b'))).toBe(true)
  })

  it('索引少列 / 多列都不通过', () => {
    expect(indexMatchesSessions([{ id: 'a' }], ids('a', 'b'))).toBe(false)
    expect(indexMatchesSessions([{ id: 'a' }, { id: 'b' }], ids('a'))).toBe(false)
  })

  it('索引里重复的 id 不通过：两条记录其实只覆盖一个会话', () => {
    expect(indexMatchesSessions([{ id: 'a' }, { id: 'a' }], ids('a'))).toBe(false)
    expect(indexMatchesSessions([{ id: 'a' }, { id: 'a' }], ids('a', 'b'))).toBe(false)
  })

  it('空索引配空会话通过，空索引配非空会话不通过', () => {
    expect(indexMatchesSessions([], ids())).toBe(true)
    expect(indexMatchesSessions([], ids('a'))).toBe(false)
  })
})
