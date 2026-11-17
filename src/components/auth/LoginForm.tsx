import clsx from 'clsx'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { AuthError, login, type AuthUser } from '../../services/auth.js'
import styles from './AuthScreen.module.css'
import { TermsRow } from './TermsRow.js'
import { PasswordToggle, TextField } from './TextField.js'

type LoginFormProps = {
  accepted: boolean
  termsFlash: number
  onAccept: (accepted: boolean) => void
  onSwitch: () => void
  onForgot: () => void
  onRequestEmail: () => void
  /** 提交时以 DOM 值为准，兜住 autofill 不触发 onChange 的情况 */
  readEmail: () => string
  /** 把 DOM 里读到的邮箱写回 state，避免重渲染丢值 */
  commitEmail: (value?: string) => boolean
  onBlockedByTerms: () => void
  onAuthenticated: (user: AuthUser) => void
}

/** 两段式：先确认身份，点「登录」后密码框从按钮位置展开 */
export const LoginForm = ({
  accepted,
  termsFlash,
  onAccept,
  onSwitch,
  onForgot,
  onRequestEmail,
  readEmail,
  commitEmail,
  onBlockedByTerms,
  onAuthenticated,
}: LoginFormProps) => {
  const t = useTranslate()
  const [step, setStep] = useState<'identity' | 'password'>('identity')
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const submit = async () => {
    if (submitting) {
      return
    }
    const emailValue = readEmail()
    if (!emailValue) {
      onRequestEmail()
      return
    }
    commitEmail(emailValue)
    if (!accepted) {
      onBlockedByTerms()
      return
    }
    if (step === 'identity') {
      setStep('password')
      window.requestAnimationFrame(() => passwordRef.current?.focus())
      return
    }
    setError(null)
    if (!password) {
      setError(t('authPasswordRequired'))
      passwordRef.current?.focus()
      return
    }
    setSubmitting(true)
    try {
      onAuthenticated(await login(emailValue, password))
    } catch (err) {
      // 后端把「账号不存在」和「密码错」合并成同一句，这里原样展示
      setError(err instanceof AuthError ? err.message : t('authNetwork'))
      passwordRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit()
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {step === 'password' ? (
        <div className={styles.passwordStage}>
          <TextField
            label={t('authPassword')}
            type={shown ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder={t('authPasswordPlaceholder')}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            inputRef={passwordRef}
            state={submitting ? 'loading' : error ? 'error' : 'default'}
            message={error}
            trailing={<PasswordToggle shown={shown} onToggle={() => setShown((value) => !value)} />}
          />
        </div>
      ) : null}

      <button
        type="submit"
        className={clsx(styles.cta, (!accepted || submitting) && styles.ctaDisabled)}
        aria-disabled={!accepted || submitting}
        aria-busy={submitting ? true : undefined}
      >
        {submitting ? <span className={styles.spinner} aria-hidden="true" /> : null}
        {submitting ? t('authLoggingIn') : t('authLoginSubmit')}
      </button>

      <button type="button" className={styles.ghost} onClick={onSwitch}>
        {t('authGoRegister')}
      </button>

      <button type="button" className={styles.forgot} onClick={onForgot}>
        {t('authForgot')}
      </button>

      <TermsRow accepted={accepted} onChange={onAccept} flashToken={termsFlash} compact />
      {!accepted && termsFlash > 0 ? (
        <span className={styles.termsHint}>{t('authTermsRequired')}</span>
      ) : null}
      {step === 'password' ? (
        <button type="button" className={styles.switchLink} onClick={onRequestEmail}>
          {t('authUseOtherEmail')}
        </button>
      ) : null}
    </form>
  )
}
