import { describe, expect, it } from 'vitest'

const { isCommand, parseSlashCommand, isSupportedCommand } =
  await import('../src/services/chat/slash')

describe('斜杠命令解析', () => {
  it('标准写法', () => {
    expect(parseSlashCommand('/compact')).toEqual({ name: 'compact', args: '' })
  })

  it('大小写与前后空格都认', () => {
    expect(parseSlashCommand('  /Compact  ')?.name).toBe('compact')
    expect(parseSlashCommand('/COMPACT')?.name).toBe('compact')
  })

  it('带参数也认，参数单独取出', () => {
    expect(parseSlashCommand('/compact 现在')).toEqual({ name: 'compact', args: '现在' })
  })

  it('「/ compact」中间有空格不算命令，按普通提问处理', () => {
    expect(parseSlashCommand('/ compact')).toBeNull()
  })

  it('多行文本不算命令', () => {
    expect(parseSlashCommand('/compact\n再问一句')).toBeNull()
  })

  it('不认识的命令名返回名字但标记为不支持', () => {
    const parsed = parseSlashCommand('/help')
    expect(parsed?.name).toBe('help')
    expect(isSupportedCommand('help')).toBe(false)
  })

  it('未知命令一律按普通提问发出去', () => {
    expect(isCommand(parseSlashCommand('/help'))).toBe(false)
    expect(isCommand(parseSlashCommand('/etc 里那个文件是干嘛的'))).toBe(false)
    expect(isCommand(parseSlashCommand('/tmp 目录满了怎么办'))).toBe(false)
  })

  it('认识的命令才算命令', () => {
    expect(isCommand(parseSlashCommand('/compact'))).toBe(true)
    expect(isCommand(parseSlashCommand('/Compact 现在'))).toBe(true)
    expect(isCommand(parseSlashCommand('帮我压缩一下'))).toBe(false)
    expect(isCommand(null)).toBe(false)
  })

  it('普通提问与空串不误判', () => {
    expect(parseSlashCommand('帮我压缩一下上下文')).toBeNull()
    expect(parseSlashCommand('')).toBeNull()
    expect(parseSlashCommand('  ')).toBeNull()
  })
})
