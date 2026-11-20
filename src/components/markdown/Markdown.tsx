import { memo, useMemo, useRef } from 'react'
import type { Source } from '../../services/chat/view.js'
import { toMdAst } from '../../services/markdown/parse.js'
import { useScrollToBottom } from '../messages/scrollContext.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'

/**
 * 渲染链路：节流 → 解析 AST → 渲染。
 * 传入 sources 时把正文里的 [citation:N] 渲染为角标。
 */
export const Markdown = memo(function Markdown({
  content,
  loading,
  cacheKey,
  className,
  disableLink,
  sources,
}: {
  content: string
  loading: boolean
  cacheKey: string
  className?: string
  disableLink: boolean
  sources?: Source[]
}) {
  const scrollToBottom = useScrollToBottom()
  /** 上一次 toMdAst 的实测耗时，节流窗口按它算；解析本身不在这里做 */
  const parseCostRef = useRef(0)
  const throttledMarkdown = useThrottleMarkdownRender(content, loading, parseCostRef)
  const ast = useMemo(() => {
    if (!throttledMarkdown) {
      return null
    }
    const started = performance.now()
    const tree = toMdAst(throttledMarkdown, { sources, disableLink })
    parseCostRef.current = performance.now() - started
    return tree
  }, [throttledMarkdown, sources, disableLink])
  return ast ? (
    <MarkdownAstRenderer
      key={cacheKey}
      className={className}
      ast={ast}
      loading={loading}
      onUpdate={scrollToBottom}
    />
  ) : null
})
