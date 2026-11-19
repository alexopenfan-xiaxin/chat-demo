import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import styles from './AuthScreen.module.css'

type HcaptchaApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string
  remove: (widgetId?: string) => void
  reset: (widgetId?: string) => void
}

declare global {
  interface Window {
    hcaptcha?: HcaptchaApi
  }
}

/** 用文档规定的 onload 回调：只等 window.hcaptcha 出现是不够的，
 *  对象挂上时内部状态还没就绪，这时 render 会静默什么都不画。 */
const SCRIPT_SRC = 'https://js.hcaptcha.com/1/api.js?render=explicit&onload=__dsHcaptchaOnload'
/** 脚本多久没回来就算加载失败：这是备用通道，等太久不如退回提示让人重试 */
const SCRIPT_TIMEOUT_MS = 8000

type OnloadWindow = Window & { __dsHcaptchaOnload?: () => void }

let scriptPromise: Promise<void> | null = null

/** 只插一次脚本；失败后清掉缓存的 promise，允许下一轮重新拉 */
const loadScript = () => {
  if (window.hcaptcha) {
    return Promise.resolve()
  }
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const scoped = window as OnloadWindow
      const script = document.createElement('script')
      const cleanup = () => {
        window.clearTimeout(timer)
        delete scoped.__dsHcaptchaOnload
      }
      const timer = window.setTimeout(() => {
        cleanup()
        scriptPromise = null
        script.remove()
        reject(new Error('hcaptcha script timeout'))
      }, SCRIPT_TIMEOUT_MS)
      scoped.__dsHcaptchaOnload = () => {
        cleanup()
        resolve()
      }
      script.src = SCRIPT_SRC
      script.async = true
      script.defer = true
      script.onerror = () => {
        cleanup()
        scriptPromise = null
        script.remove()
        reject(new Error('hcaptcha script failed'))
      }
      document.head.append(script)
    })
  }
  return scriptPromise
}

const isDarkTheme = () => document.body.dataset.dsDarkTheme !== undefined

const isMobile = () => window.matchMedia('(max-width: 767px)').matches

type HcaptchaProps = {
  /** 每次改动都会重挂载 widget：令牌一次性，用完必须换新的 */
  resetSignal: number
  onToken: (token: string | null) => void
  /** 备用通道自己也起不来时通知父组件，由它决定显示什么 */
  onUnavailable: () => void
}

/**
 * hCaptcha 备用通道。只有 Turnstile 加载失败时才挂载（见 Captcha.tsx），
 * 版式与 Turnstile 共用同一个 65px 槽位，切换时不会把表单顶下去。
 */
export const Hcaptcha = ({ resetSignal, onToken, onUnavailable }: HcaptchaProps) => {
  const t = useTranslate()
  const holder = useRef<HTMLDivElement | null>(null)
  const widgetId = useRef<string | null>(null)
  const onTokenRef = useRef(onToken)
  const onUnavailableRef = useRef(onUnavailable)
  const [themeDark, setThemeDark] = useState(isDarkTheme)

  useEffect(() => {
    onTokenRef.current = onToken
    onUnavailableRef.current = onUnavailable
  }, [onToken, onUnavailable])

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeDark(isDarkTheme()))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
    return () => observer.disconnect()
  }, [])

  const mount = useCallback(async () => {
    const container = holder.current
    if (!container) {
      return
    }
    try {
      await loadScript()
    } catch {
      onUnavailableRef.current()
      return
    }
    const api = window.hcaptcha
    if (!api) {
      onUnavailableRef.current()
      return
    }
    // 只在真有旧 widget 时 remove：hCaptcha 的 remove(undefined) 会抛错，
    // 而这里在 async 里，抛出去就是静默失败，widget 根本不画
    if (widgetId.current) {
      api.remove(widgetId.current)
      widgetId.current = null
    }
    widgetId.current = api.render(container, {
      sitekey: __HCAPTCHA_SITE_KEY__,
      theme: themeDark ? 'dark' : 'light',
      // hCaptcha 只认 normal / compact / invisible：'flexible' 是 Turnstile 的取值，
      // 传进去不会报错，但 widget 会静默不渲染，所以移动端这里用 compact。
      size: isMobile() ? 'compact' : 'normal',
      hl: document.documentElement.lang === 'en-US' ? 'en' : 'zh-cn',
      callback: (token: string) => onTokenRef.current(token),
      'error-callback': () => {
        onTokenRef.current(null)
        onUnavailableRef.current()
      },
      'expired-callback': () => onTokenRef.current(null),
    })
  }, [themeDark])

  useEffect(() => {
    void mount()
    return () => {
      if (window.hcaptcha && widgetId.current) {
        window.hcaptcha.remove(widgetId.current)
        widgetId.current = null
      }
    }
  }, [mount, resetSignal])

  return (
    <div className={styles.turnstile} aria-label={t('authTurnstileLabel')} role="group">
      <div ref={holder} className={styles.hcaptchaReady} />
      <span className={styles.srOnly}>{t('authTurnstileLabel')}</span>
    </div>
  )
}
