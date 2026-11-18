import { describe, expect, it } from 'vitest'
import { isAttachmentEntry } from '../src/services/chat/history/importArchive'

describe('isAttachmentEntry', () => {
  it('识别会话自己的附件条目', () => {
    expect(isAttachmentEntry('chat_sessions/abc_files/a_b.webp')).toBe(true)
    expect(
      isAttachmentEntry(
        'chat_sessions/a79eeff5-6e08-4799-b36f-2cba7f7731bf_files/339e7ab4-x_Screenshot.webp'
      )
    ).toBe(true)
  })

  it('会话 JSON 不算附件，别被当图片存进去', () => {
    expect(isAttachmentEntry('chat_sessions/abc.json')).toBe(false)
    expect(isAttachmentEntry('chat_sessions/abc_files')).toBe(false)
    expect(isAttachmentEntry('manifest.json')).toBe(false)
    expect(isAttachmentEntry('chat_sessions/abc_files/nested/deep.png')).toBe(true)
  })
})
