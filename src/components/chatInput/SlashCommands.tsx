import { useTranslate } from '../../i18n/index.js'
import styles from './SlashCommands.module.css'

/** 目前只有这一条；以后加命令只往这里加一项 */
export const SLASH_COMMANDS = [{ command: '/compact', hintKey: 'compactCommandHint' }] as const

export type SlashCommand = (typeof SLASH_COMMANDS)[number]['command']

/**
 * 斜杠命令列表：输入框第一个字符是 `/` 时在输入框上方弹出。
 * 点击只把命令填进输入框，由用户按回车执行——回车那条路径在 sendMessage 里拦截。
 */
export const SlashCommands = ({
  text,
  onPick,
}: {
  text: string
  onPick: (command: SlashCommand) => void
}) => {
  const t = useTranslate()
  if (!text.startsWith('/') || text.includes('\n')) {
    return null
  }
  const query = text.slice(1).trim().toLowerCase()
  // 已经完整填好一条命令时收起列表，避免遮住输入内容
  const items = SLASH_COMMANDS.filter(
    ({ command }) => command.slice(1).startsWith(query) && query !== command.slice(1)
  )
  if (items.length === 0) {
    return null
  }
  return (
    <div className={styles.panel} role="listbox">
      {items.map(({ command, hintKey }) => (
        <button
          key={command}
          type="button"
          role="option"
          aria-selected={false}
          className={styles.item}
          // 用 mousedown 保住输入框焦点：click 之前 textarea 会先失焦
          onMouseDown={(event) => {
            event.preventDefault()
            onPick(command)
          }}
        >
          <span className={styles.command}>{command}</span>
          <span className={styles.hint}>{t(hintKey)}</span>
        </button>
      ))}
    </div>
  )
}
