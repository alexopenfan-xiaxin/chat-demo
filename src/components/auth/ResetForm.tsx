import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { AuthError, requestCode, resetPassword } from '../../services/auth.js'
import styles from './AuthScreen.module.css'
import { OtpInput } from './OtpInput.js'
import { TermsRow } from './TermsRow.js'
import { Turnstile } from './Turnstile.js'
import { PasswordToggle, TextField } from './TextField.js'

const CODE_LENGTH = 6
const RESEND_SECONDS = 60
const CODE_TTL_MINUTES = 10
const emptyCode = () => Array.from({ length: CODE_LENGTH }, () => '')

type ResetFormProps = {
  accepted: boolean
  termsFlash: number
  onAccept: (accepted: boolean) => void
  readEmail: () => string
  commitEmail: (value?: string) => boolean
  onRequestEmail: () => void
  onBlockedByTerms: () => void
  /** 成功后直接回登录页并预填邮箱：重置已经吊销了全部会话，不能假装还登录着 */
  onDone: (email: string) => void
  onSwitch: () => void
}

/** 忘记密码：邮箱 → 人机验证 → 邮件码 → 新密码，四步共用注册那套 OTP 与冷却 */
export const ResetForm = ({
  accepted,
  termsFlash,
  onAccept,
  readEmail,
  commitEmail,
  onRequestEmail,
  onBlockedByTerms,
  onDone,
  onSwitch,
}: ResetFormProps) => {
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
  const [now, setNow] = useState(() => Date.now())
  const [sendError, setSendError] = useState<string | null>(null)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const tick = () => setNow(Date.now())
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [])

  const remaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))
  const codeReady = code.every((digit) => digit !== '')

  const send = async () => {
    if (sending || remaining > 0) {
      return
    }
    setSendError(null)
    const email = readEmail()
    if (!email) {
      onRequestEmail()
      return
    }
    commitEmail(email)
    if (!turnstileToken) {
      setSendError(t('authTurnstileRequired'))
      return
    }
    setSending(true)
    try {
      await requestCode(email, turnstileToken, 'reset')
      setSent(true)
      setCooldownUntil(Date.now() + RESEND_SECONDS * 1000)
      setCodeError(null)
    } catch (err) {
      setSendError(err instanceof AuthError ? err.message : t('authNetwork'))
    } finally {
      setTurnstileToken(null)
      setTurnstileSignal((value) => value + 1)
      setSending(false)
    }
  }

  const submit = async () => {
    if (submitting) {
      return
    }
    const email = readEmail()
    if (!email) {
      onRequestEmail()
      return
    }
    commitEmail(email)
    if (!accepted) {
      onBlockedByTerms()
      return
    }
    setFormError(null)
    setCodeError(null)
    setPasswordError(null)
    setConfirmError(null)
    if (!codeReady) {
      setCodeError(t('authCodeIncomplete'))
      return
    }
    if (password.length < 8) {
      setPasswordError(t('authPasswordTooShort'))
      passwordRef.current?.focus()
      return
    }
    if (password !== confirm) {
      setConfirmError(t('authPasswordMismatch'))
      return
    }
    setSubmitting(true)
    try {
      await resetPassword(email, code.join(''), password)
      onDone(email)
    } catch (err) {
      const message = err instanceof AuthError ? err.message : t('authNetwork')
      if (message.includes('验证码')) {
        setCodeError(message)
        setCode(emptyCode())
      } else if (message.includes('密码')) {
        setPasswordError(message)
      } else {
        setFormError(message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        void submit()
      }}
      noValidate
    >
      <div className={styles.sendRow}>
        <span className={sendError ? styles.error : styles.hint}>
          {sendError ?? (sent ? t('authCodeSent', { minutes: CODE_TTL_MINUTES }) : '')}
        </span>
        <button type="button" className={styles.sendButton} disabled={sending || remaining > 0} onClick={() => void send()}>
          {remaining > 0 ? t('authResendIn', { seconds: remaining }) : sent ? t('authResend') : t('authSendCode')}
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
          invalid={Boolean(codeError)}
          success={codeReady && !codeError}
        />
        <div className={styles.msgRow}>
          {codeError ? (
            <span className={styles.error} role="alert">
              {codeError}
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.passwordStage}>
        {/* 不自动聚焦：让用户自己敲一遍新密码，确认记住了 */}
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
        type="submit"
        className={clsx(styles.cta, (!accepted || submitting) && styles.ctaDisabled)}
        aria-disabled={!accepted || submitting}
        aria-busy={submitting ? true : undefined}
      >
        {submitting ? <span className={styles.spinner} aria-hidden="true" /> : null}
        {t('authResetSubmit')}
      </button>

      <button type="button" className={styles.ghost} onClick={onSwitch}>
        {t('authResetBack')}
      </button>

      <TermsRow accepted={accepted} onChange={onAccept} flashToken={termsFlash} />
      {!accepted ? <span className={styles.termsHint}>{t('authTermsRequired')}</span> : null}
    </form>
  )
}
