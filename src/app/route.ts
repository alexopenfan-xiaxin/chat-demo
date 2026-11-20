import { useEffect, useState } from 'react'

/** 记忆空间：独立二级页面，不是浮层 */
export const MEMORY_PATH = '/memory'

const readPath = () => (typeof window === 'undefined' ? '/' : window.location.pathname)

export const useRoute = () => {
  const [path, setPath] = useState(readPath)
  useEffect(() => {
    const sync = () => setPath(readPath())
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])
  return path
}

/** 只改地址栏并广播一次，不整页重载 */
export const navigateTo = (path: string) => {
  if (window.location.pathname === path) {
    return
  }
  window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
