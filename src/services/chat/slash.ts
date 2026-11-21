/**
 * 斜杠命令解析。
 *
 * 手敲的写法比面板点选的随意得多：`/Compact`、`/compact 现在` 都要认，所以这里按
 * 「斜杠紧跟纯字母、不区分大小写」解析，`/` 与命令名之间不能有空格。
 *
 * 只有已实现的命令才算命令（见 `isCommand`）；解析不出、或命令名不认识，一律返回给调用方
 * 当普通提问发出去——`/etc 里那个文件是干嘛的`、`/tmp 目录满了怎么办` 这类问路径的提问
 * 不能被吞掉，`/help` 这种也交给模型自己回答，不做拦截。
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
