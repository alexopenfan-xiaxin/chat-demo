import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import styles from './AuthScreen.module.css'

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string
  remove: (widgetId?: string) => void
  reset: (widgetId?: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

let scriptPromise: Promise<void> | null = null

/** 只插一次脚本；失败后允许重试（把缓存的 promise 清掉） */
const loadScript = () => {
  if (window.turnstile) {
    return Promise.resolve()
  }
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = SCRIPT_SRC
      script.async = true
      script.defer = true
      script.onload = () => resolve()
      script.onerror = () => {
        scriptPromise = null
        script.remove()
        reject(new Error('turnstile script failed'))
      }
      document.head.append(script)
    })
  }
  return scriptPromise
}

const isDarkTheme = () => document.body.dataset.dsDarkTheme !== undefined

const isMobile = () => window.matchMedia('(max-width: 767px)').matches

type TurnstileProps = {
  /** 每次改动都会重挂载 widget：令牌一次性，用完必须换新的 */
  resetSignal: number
  onToken: (token: string | null) => void
  onError?: () => void
}

/**
 * 人机验证。先占 65px 再渲染，避免脚本回来把下面的表单顶下去；
 * 主题切换与令牌重置都走「remove 再 render」，不做 transform 缩放。
 */
export const Turnstile = ({ resetSignal, onToken, onError }: TurnstileProps) => {
  const t = useTranslate()
  const holder = useRef<HTMLDivElement | null>(null)
  const widgetId = useRef<string | null>(null)
  // 父组件每次渲染都会传新的内联函数；用 ref 留住最新的那两个，
  // 别让它们进 mount 的依赖——否则 setInterval 每秒一次 setNow 都会把 widget 拆了重建。
  const onTokenRef = useRef(onToken)
  const onErrorRef = useRef(onError)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [themeDark, setThemeDark] = useState(isDarkTheme)

  // 跟随后台的深浅色切换（body 上的 data-ds-dark-theme 由 theme.ts 维护）
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeDark(isDarkTheme()))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    onTokenRef.current = onToken
    onErrorRef.current = onError
  }, [onToken, onError])

  const mount = useCallback(async () => {
    const container = holder.current
    if (!container) {
      return
    }
    try {
      await loadScript()
    } catch {
      setFailed(true)
      return
    }
    const api = window.turnstile
    if (!api) {
      setFailed(true)
      return
    }
    setFailed(false)
    api.remove(widgetId.current ?? undefined)
    widgetId.current = api.render(container, {
      sitekey: __TURNSTILE_SITE_KEY__,
      theme: themeDark ? 'dark' : 'light',
      size: isMobile() ? 'flexible' : 'normal',
      language: document.documentElement.lang === 'en-US' ? 'en' : 'zh-cn',
      callback: (token: string) => onTokenRef.current(token),
      'error-callback': () => {
        onTokenRef.current(null)
        onErrorRef.current?.()
      },
      'expired-callback': () => onTokenRef.current(null),
    })
  }, [themeDark])

  useEffect(() => {
    void mount()
    return () => {
      if (window.turnstile && widgetId.current) {
        window.turnstile.remove(widgetId.current)
        widgetId.current = null
      }
    }
  }, [mount, resetSignal, attempt])

  return (
    <div className={styles.turnstile} aria-label={t('authTurnstileLabel')} role="group">
      {failed ? (
        <button
          type="button"
          className={styles.turnstileFailed}
          onClick={() => {
            setFailed(false)
            setAttempt((value) => value + 1)
          }}
        >
          {t('authTurnstileFailed')}
        </button>
      ) : (
        <>
          <div ref={holder} className={styles.turnstileReady} />
          <span className={styles.srOnly}>{t('authTurnstileLabel')}</span>
        </>
      )}
    </div>
  )
}
