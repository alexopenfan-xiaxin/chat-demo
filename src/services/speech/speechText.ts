import type { Nodes, Parent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-llm-math'

/**
 * 把回复的 Markdown 正文转成适合朗读的纯文本。
 *
 * 为什么在前端做：这里拿得到渲染前的正文，用与渲染同一套 mdast 解析器，
 * 判断的是节点类型而不是拿正则去猜；服务端只负责合成。
 *
 * 取舍（按听感定的，不是按规范定的）：
 * - 代码块整段不念：逐个念符号等于噪音。但整条回复里**第一次**遇到时会念一句
 *   「代码略」，否则听众以为少了一段；后面再遇到就静默跳过，免得重复到烦。
 * - 行内代码是纯标识符（useState、p-map）就照念，它本身就是句子的一部分；
 *   带符号的（file.slice().arrayBuffer()）替换成「代码」，否则会念成一串数字和括号。
 * - 链接只念文字，URL 一律丢掉；图片、HTML、公式、分隔线、脚注标记直接丢。
 * - 表格每行念成一句、单元格之间用逗号，竖线和对齐符号不进正文。
 * - 列表项逐句念，不念圆点和序号；句末标点保留，否则没有停顿。
 */

/** 正文里的来源角标，是纯文本形态，解析器不会当链接处理，得自己去掉 */
const CITATION = /\[citation:\d+\]/g

/** 适合直接念的短标识符：字母数字下划线连字符，最长 24 个字符 */
const SPEAKABLE_IDENTIFIER = /^[\p{L}\p{N}_-]{1,24}$/u

/** 裸 HTML 只丢掉标签本身，标签里的文字仍然要念，否则会整段消失 */
const stripTags = (value: string) => value.replace(/<[^>]*>/g, ' ')

/** 代码块被跳过后念的一句提示，整条回复只念一次 */
const CODE_MARKER = '代码略。'

/** 行内代码带符号时替换成的词，比整段丢掉更不容易让句子断裂 */
const CODE_WORD = '代码'

const inline = (node: Nodes): string => {
  switch (node.type) {
    case 'text':
      return node.value.replace(CITATION, '')
    case 'inlineCode': {
      const value = node.value.trim()
      return SPEAKABLE_IDENTIFIER.test(value) ? value : CODE_WORD
    }
    case 'break':
      return '\n'
    case 'html':
      return stripTags(node.value)
    case 'image':
    case 'imageReference':
    case 'footnoteReference':
    case 'inlineMath':
    case 'math':
      return ''
    default:
      // 加粗、斜体、删除线、链接：定界符都在解析时吃掉了，只留 children
      return 'children' in node ? (node as Parent).children.map(inline).join('') : ''
  }
}

/** 每个块级节点产出一行或多行；行内空白压成单个空格 */
const collect = (node: Nodes, lines: string[], state: { code: boolean }): void => {
  const push = (value: string) => {
    const text = value.replace(/[ \t]+/g, ' ').trim()
    if (text) {
      lines.push(text)
    }
  }
  switch (node.type) {
    case 'root':
    case 'blockquote':
    case 'list':
    case 'listItem':
      for (const child of (node as Parent).children) {
        collect(child, lines, state)
      }
      return
    case 'paragraph':
    case 'heading':
      push((node as Parent).children.map(inline).join(''))
      return
    case 'code':
      // 整段代码不念；只在第一次出现时提示一句，避免听众以为内容缺失
      if (!state.code) {
        state.code = true
        lines.push(CODE_MARKER)
      }
      return
    case 'table':
      for (const row of (node as Parent).children) {
        push((row as Parent).children.map((cell) => (cell as Parent).children.map(inline).join('')).join('，'))
      }
      return
    case 'html':
      // HTML 块（div、表格的原始写法）：标签去掉，里面的文字照样念
      push(stripTags(node.value))
      return
    case 'thematicBreak':
    case 'definition':
    case 'footnoteDefinition':
    case 'math':
      return
    default:
      if ('children' in node) {
        for (const child of (node as Parent).children) {
          collect(child, lines, state)
        }
      }
  }
}

/** 正文转朗读文本；无法朗读的内容（纯代码、纯公式）会得到空字符串 */
export const toSpeechText = (markdown: string): string => {
  if (!markdown.trim()) {
    return ''
  }
  const ast = fromMarkdown(markdown, {
    extensions: [
      // 与渲染器一致：缩进代码块禁用，否则有前导空格的列表会被当成代码
      { ...gfm(), disable: { null: ['codeIndented'] } },
      math({ singleDollarTextMath: true }),
    ],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
  const lines: string[] = []
  collect(ast, lines, { code: false })
  return lines.join('\n')
}
