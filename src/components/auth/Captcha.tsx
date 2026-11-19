import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import styles from './AuthScreen.module.css'
import { Hcaptcha } from './Hcaptcha.js'
import { Turnstile } from './Turnstile.js'
import type { CaptchaProvider } from '../../services/auth.js'

type CaptchaProps = {
  /** 每次改动都会重挂载 widget：令牌一次性，用完必须换新的 */
  resetSignal: number
  onToken: (token: string | null, provider: CaptchaProvider) => void
  /** 两条通道都起不来时才调用 */
  onError?: () => void
}

/**
 * 人机验证的外层：先挂 Turnstile，脚本拉不下来就自动换成 hCaptcha，用户不用点任何东西。
 *
 * 为什么要有这一层：Turnstile 的脚本必须从 challenges.cloudflare.com 拉，这个域名在
 * 国内网络下经常连不上，界面上就只剩「加载失败，点此重试」——重试同一个拉不下来的
 * 域名没有意义，所以这里改成自己换一条通道。
 *
 * 两条通道各自真实验证，前端只是告诉后端「这次是哪个 token」。
 */
export const Captcha = ({ resetSignal, onToken, onError }: CaptchaProps) => {
  const t = useTranslate()
  const [provider, setProvider] = useState<CaptchaProvider>('turnstile')
  const [dead, setDead] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const onTokenRef = useRef(onToken)
  const onErrorRef = useRef(onError)
  const providerRef = useRef<CaptchaProvider>('turnstile')

  useEffect(() => {
    onTokenRef.current = onToken
    onErrorRef.current = onError
  }, [onToken, onError])

  /** Turnstile 起不来：换成 hCaptcha，并且把 provider 一起报给上层（此时还没 token） */
  const fallBackToHcaptcha = useCallback(() => {
    if (providerRef.current === 'hcaptcha') {
      return
    }
    providerRef.current = 'hcaptcha'
    setProvider('hcaptcha')
    // 换通道意味着旧 token 作废，同时把新的 provider 报给上层，提交时才知道验哪边
    onTokenRef.current(null, 'hcaptcha')
  }, [])

  /** 备用通道也起不来：这时候才让人看到「切换网络后重试」 */
  const bothFailed = useCallback(() => {
    setDead(true)
    onTokenRef.current(null, 'hcaptcha')
    onErrorRef.current?.()
  }, [])

  const retry = () => {
    setDead(false)
    providerRef.current = 'turnstile'
    setProvider('turnstile')
    setAttempt((value) => value + 1)
  }

  if (dead) {
    return (
      <div className={styles.turnstile} aria-label={t('authTurnstileLabel')} role="group">
        <button type="button" className={styles.turnstileFailed} onClick={retry}>
          {t('authCaptchaFailed')}
        </button>
      </div>
    )
  }

  return (
    <div key={attempt}>
      {provider === 'hcaptcha' ? (
        <Hcaptcha
          resetSignal={resetSignal}
          onToken={(token) => onTokenRef.current(token, 'hcaptcha')}
          onUnavailable={bothFailed}
        />
      ) : (
        <Turnstile
          resetSignal={resetSignal}
          onToken={(token) => onTokenRef.current(token, 'turnstile')}
          onUnavailable={fallBackToHcaptcha}
          onError={() => onTokenRef.current(null, 'turnstile')}
        />
      )}
    </div>
  )
}
