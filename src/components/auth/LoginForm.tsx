import clsx from 'clsx'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { AuthError, login, type AuthUser } from '../../services/auth.js'
import styles from './AuthScreen.module.css'
import { TermsRow } from './TermsRow.js'
import { PasswordToggle, TextField } from './TextField.js'

type LoginFormProps = {
  email: string
  accepted: boolean
  termsFlash: number
  onAccept: (accepted: boolean) => void
  onSwitch: () => void
  onRequestEmail: () => void
  onBlockedByTerms: () => void
  onAuthenticated: (user: AuthUser) => void
}

/** 两段式：先确认身份，点「登录」后密码框从按钮位置展开 */
export const LoginForm = ({
  email,
  accepted,
  termsFlash,
  onAccept,
  onSwitch,
  onRequestEmail,
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
    if (!email) {
      onRequestEmail()
      return
    }
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
      onAuthenticated(await login(email.trim(), password))
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

      <TermsRow accepted={accepted} onChange={onAccept} flashToken={termsFlash} />
      {!accepted ? <span className={styles.termsHint}>{t('authTermsRequired')}</span> : null}
      {step === 'password' ? (
        <button type="button" className={styles.switchLink} onClick={onRequestEmail}>
          {t('authUseOtherEmail')}
        </button>
      ) : null}
    </form>
  )
}
