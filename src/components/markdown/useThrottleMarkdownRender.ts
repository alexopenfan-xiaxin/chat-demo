import { useEffect, useRef, useState } from 'react'

/** 两次更新之间最少等这么久：再快也没有意义，屏幕上一帧就是这么长 */
const MIN_STEP = 33
/** 两次更新之间最多等这么久：解析再贵也不能让人等到两秒才见字 */
const MAX_WAIT = 250

/**
 * 流式过程中按「真实解析耗时」节流 Markdown 内容的更新。
 *
 * 窗口 = clamp(上次 `toMdAst` 的实测耗时 × 2, 33ms, 250ms)：
 * 解析便宜时贴着帧率走，解析变贵（长文本）时自动放宽，但封顶 250ms。
 *
 * 这里曾经用「距上次更新开始的时间 × 2」当窗口，那个量会随每次更新自己翻倍、
 * 一路涨到 2000ms，表现就是「隔一会儿突然冒一串字」。
 */
export const useThrottleMarkdownRender = (
  content: string,
  enable: boolean,
  costRef: { current: number }
) => {
  const updatableAtRef = useRef(0)
  const [output, setOutput] = useState(content)

  useEffect(() => {
    const cost = costRef.current
    const window = Math.min(MAX_WAIT, Math.max(MIN_STEP, cost * 2))
    updatableAtRef.current = performance.now() + window
  }, [output, costRef])

  useEffect(() => {
    if (!enable) {
      return
    }
    const update = () => {
      setOutput(content)
    }
    const delay = updatableAtRef.current - performance.now()
    if (delay <= 0) {
      update()
      return
    }
    const timer = setTimeout(update, delay)
    return () => clearTimeout(timer)
  }, [content, enable])

  return enable ? output : content
}
