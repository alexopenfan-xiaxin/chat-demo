import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { AuthError, register, requestCode, type AuthUser } from '../../services/auth.js'
import styles from './AuthScreen.module.css'
import { OtpInput } from './OtpInput.js'
import { TermsRow } from './TermsRow.js'
import { Turnstile } from './Turnstile.js'
import { PasswordToggle, TextField } from './TextField.js'

/** 与 server/auth-core.ts 的常量对齐，前端不自己编数字 */
const CODE_LENGTH = 6
const RESEND_SECONDS = 60
const CODE_TTL_MINUTES = 10

const emptyCode = () => Array.from({ length: CODE_LENGTH }, () => '')

type RegisterFormProps = {
  accepted: boolean
  termsFlash: number
  onAccept: (accepted: boolean) => void
  onSwitch: () => void
  onRequestEmail: () => void
  /** 提交时以 DOM 值为准，兜住 autofill 不触发 onChange 的情况 */
  readEmail: () => string
  onBlockedByTerms: () => void
  onAuthenticated: (user: AuthUser) => void
}

/** 注册：邮箱（在外层身份行）→ 人机验证 → 验证码 → 设密码 */
export const RegisterForm = ({
  accepted,
  termsFlash,
  onAccept,
  onSwitch,
  onRequestEmail,
  readEmail,
  onBlockedByTerms,
  onAuthenticated,
}: RegisterFormProps) => {
  const t = useTranslate()
  const [code, setCode] = useState<string[]>(emptyCode)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [shown, setShown] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [turnstileSignal, setTurnstileSignal] = useState(0)
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [expiresAt, setExpiresAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [sendError, setSendError] = useState<string | null>(null)
  const [otpError, setOtpError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const passwordRef = useRef<HTMLInputElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)

  // 每秒对齐一次；切后台回来立刻按时间戳重算，不靠 tick 累加
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const timer = window.setInterval(tick, 1000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        tick()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const remaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))
  const ttlSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  const codeReady = code.every((digit) => digit !== '')

  const resetTurnstile = () => {
    setTurnstileToken(null)
    setTurnstileSignal((value) => value + 1)
  }

  const send = async () => {
    if (sending || remaining > 0) {
      return
    }
    setSendError(null)
    setFormError(null)
    const emailValue = readEmail()
    if (!emailValue) {
      onRequestEmail()
      return
    }
    if (!turnstileToken) {
      setSendError(t('authTurnstileRequired'))
      return
    }
    setSending(true)
    try {
      await requestCode(emailValue, turnstileToken)
      setSent(true)
      setCooldownUntil(Date.now() + RESEND_SECONDS * 1000)
      setExpiresAt(Date.now() + CODE_TTL_MINUTES * 60 * 1000)
      setOtpError(null)
    } catch (err) {
      setSendError(err instanceof AuthError ? err.message : t('authNetwork'))
    } finally {
      // 令牌一次性：无论成功失败，下一次发送都要新的
      resetTurnstile()
      setSending(false)
    }
  }

  const submit = async () => {
    if (submitting) {
      return
    }
    const emailValue = readEmail()
    if (!emailValue) {
      onRequestEmail()
      return
    }
    if (!accepted) {
      onBlockedByTerms()
      return
    }
    setFormError(null)
    setOtpError(null)
    setPasswordError(null)
    setConfirmError(null)
    if (!codeReady) {
      setOtpError(t('authCodeIncomplete'))
      return
    }
    if (password.length < 8) {
      setPasswordError(t('authPasswordTooShort'))
      passwordRef.current?.focus()
      return
    }
    if (password.length > 200) {
      setPasswordError(t('authPasswordTooLong'))
      passwordRef.current?.focus()
      return
    }
    if (password !== confirm) {
      setConfirmError(t('authPasswordMismatch'))
      return
    }
    setSubmitting(true)
    try {
      onAuthenticated(await register(emailValue, code.join(''), password))
    } catch (err) {
      const message = err instanceof AuthError ? err.message : t('authNetwork')
      if (message.includes('验证码')) {
        // 错误次数超限时后端已允许重新获取：清空重填，并让「重新发送」立刻可点
        setOtpError(message)
        setCode(emptyCode())
        if (err instanceof AuthError && err.status === 429) {
          setCooldownUntil(0)
        }
      } else if (message.includes('密码')) {
        setPasswordError(message)
      } else if (message.includes('邮箱')) {
        setFormError(message)
      } else {
        setFormError(message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const codeHint = !sent
    ? null
    : ttlSeconds > 0 && ttlSeconds <= 60
      ? t('authCodeExpiring')
      : t('authCodeSent', { minutes: CODE_TTL_MINUTES })

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        void submit()
      }}
      noValidate
    >
      <div className={styles.sendRow}>
        <span
          className={
            sendError ? styles.error : ttlSeconds > 0 && ttlSeconds <= 60 ? styles.hintWarn : styles.hint
          }
        >
          {sendError ?? codeHint ?? ''}
        </span>
        <button
          type="button"
          className={styles.sendButton}
          disabled={sending || remaining > 0}
          onClick={() => void send()}
        >
          {remaining > 0
            ? t('authResendIn', { seconds: remaining })
            : sent
              ? t('authResend')
              : t('authSendCode')}
        </button>
      </div>

      <Turnstile
        resetSignal={turnstileSignal}
        onToken={setTurnstileToken}
        onError={() => setSendError(t('authTurnstileFailed'))}
      />

      <div className={styles.stage}>
        <span className={styles.label}>{t('authCodeLabel')}</span>
        <OtpInput
          value={code}
          onChange={setCode}
          onComplete={() => submitRef.current?.focus()}
          invalid={Boolean(otpError)}
          success={codeReady && !otpError}
        />
        <div className={styles.msgRow}>
          {otpError ? (
            <span className={styles.error} role="alert">
              {otpError}
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.passwordStage}>
        <TextField
          label={t('authPassword')}
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder={t('authPasswordPlaceholder')}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          inputRef={passwordRef}
          state={passwordError ? 'error' : 'default'}
          message={passwordError}
          trailing={<PasswordToggle shown={shown} onToggle={() => setShown((value) => !value)} />}
        />
        <TextField
          label={t('authPasswordConfirm')}
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder={t('authPasswordPlaceholder')}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          onBlur={() => {
            if (confirm !== '' && confirm !== password) {
              setConfirmError(t('authPasswordMismatch'))
            } else {
              setConfirmError(null)
            }
          }}
          state={confirmError ? 'error' : 'default'}
          message={confirmError}
        />
      </div>

      {formError ? (
        <div className={styles.msgRow} role="alert" aria-live="assertive">
          <span className={styles.error}>{formError}</span>
        </div>
      ) : null}

      <button
        ref={submitRef}
        type="submit"
        className={clsx(styles.cta, (!accepted || submitting) && styles.ctaDisabled)}
        aria-disabled={!accepted || submitting}
        aria-busy={submitting ? true : undefined}
      >
        {submitting ? <span className={styles.spinner} aria-hidden="true" /> : null}
        {submitting ? t('authRegistering') : t('authRegisterSubmit')}
      </button>

      <button type="button" className={styles.ghost} onClick={onSwitch}>
        {t('authGoLogin')}
      </button>

      <TermsRow accepted={accepted} onChange={onAccept} flashToken={termsFlash} />
      {!accepted && termsFlash > 0 ? (
        <span className={styles.termsHint}>{t('authTermsRequired')}</span>
      ) : null}
    </form>
  )
}
