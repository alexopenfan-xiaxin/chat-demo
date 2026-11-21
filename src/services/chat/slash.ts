/**
 * 斜杠命令解析。
 *
 * 手敲的写法比面板点选的随意得多：`/Compact`、`/compact 现在`、` / compact` 都会出现，
 * 所以这里统一按「首个单词、不区分大小写」解析；解析不出命令时返回 null（当普通提问发出去），
 * 认出了命令名但没实现时由调用方提示未知命令，绝不把命令本身当提问发给上游。
 */
export type SlashCommandName = 'compact'

/** name 保留原始的小写命令名，可能是不支持的；用 isSupportedCommand 判断 */
export type ParsedCommand = { name: string; args: string }

const COMMANDS: ReadonlySet<string> = new Set(['compact'])

/** 只认整段文字以 `/` 开头、且第一段是纯字母的情况；带换行的多行文本不算命令 */
export const parseSlashCommand = (text: string): ParsedCommand | null => {
  if (text.includes('\n')) {
    return null
  }
  const match = /^\s*\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) {
    return null
  }
  const name = match[1].toLowerCase()
  return { name, args: (match[2] ?? '').trim() }
}

export const isSupportedCommand = (name: string): name is SlashCommandName => COMMANDS.has(name)

/**
 * 这条输入是不是我们认识的命令。
 *
 * 只拦认识的命令名，其余一律按普通提问发出去：`/help` 留给用户自己问，
 * `/etc 里那个文件是干嘛的`、`/tmp 目录满了怎么办` 这种问 Unix 路径的更不能被吃掉。
 */
export const isCommand = (
  command: ParsedCommand | null
): command is ParsedCommand & { name: SlashCommandName } =>
  command !== null && isSupportedCommand(command.name)
