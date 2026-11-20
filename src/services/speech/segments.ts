/**
 * 按句子把朗读文本切成段。
 *
 * 为什么分段：整段提交要等整段合成完才出第一个音，十几秒的回复就要等十几秒。
 * 段切得太大首段出声就慢，切得太小句子会被念得支离破碎，所以取 100–200 字。
 *
 * 切口按句子末尾的标点（。！？；换行）找，绝不从句子中间切开；
 * 单句本身就超过上限时，才退到逗号、顿号、冒号处切，实在没有标点才硬切。
 */

/** 一段的目标长度，等于服务端一次合成的文本量 */
export const SPEECH_SEGMENT_MIN = 100
export const SPEECH_SEGMENT_MAX = 200

/** 句末标点：同时作为切段的第一优先级 */
const SENTENCE_END = '。！？!?；;\n'

/** 句子内部可以断开的位置，只在单句超长时使用 */
const CLAUSE_END = '，、：,:'

const sentences = (text: string): string[] => {
  const out: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    if (!SENTENCE_END.includes(text[index])) {
      continue
    }
    // 「？！」「……」这类连写一起算当前句的结尾
    let end = index + 1
    while (end < text.length && SENTENCE_END.includes(text[end])) {
      end += 1
    }
    out.push(text.slice(start, end))
    start = end
    index = end - 1
  }
  if (start < text.length) {
    out.push(text.slice(start))
  }
  return out.filter((sentence) => sentence.trim().length > 0)
}

/** 单句超过上限时切成若干块：优先在逗号处断，没有标点才按字数硬切 */
const cutLongSentence = (sentence: string, max: number): string[] => {
  if (sentence.length <= max) {
    return [sentence]
  }
  const out: string[] = []
  let rest = sentence
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = -1
    for (const mark of CLAUSE_END) {
      cut = Math.max(cut, window.lastIndexOf(mark))
    }
    // 断点太靠前（不到一半）就不值得，宁可硬切
    const at = cut >= max / 2 ? cut + 1 : max
    out.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest) {
    out.push(rest)
  }
  return out
}

/** 把朗读文本切成首段尽量短、其余不超上限的段；顺序拼回去等于原文 */
export const splitSpeechSegments = (
  text: string,
  { min = SPEECH_SEGMENT_MIN, max = SPEECH_SEGMENT_MAX }: { min?: number; max?: number } = {}
): string[] => {
  const trimmed = text.trim()
  if (!trimmed) {
    return []
  }
  const pieces = sentences(trimmed).flatMap((sentence) => cutLongSentence(sentence, max))
  const segments: string[] = []
  let buffer = ''
  for (const piece of pieces) {
    if (buffer && buffer.length + piece.length > max) {
      segments.push(buffer)
      buffer = ''
    }
    buffer += piece
    if (buffer.length >= min) {
      segments.push(buffer)
      buffer = ''
    }
  }
  if (buffer) {
    const last = segments[segments.length - 1]
    // 尾巴太短就并进上一段，省一次请求，也不至于让最后一句孤零零地单独合成
    if (last !== undefined && buffer.length < min && last.length + buffer.length <= max + min) {
      segments[segments.length - 1] = last + buffer
    } else {
      segments.push(buffer)
    }
  }
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
}
