import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { AuthError, login, type AuthUser } from '../../services/auth.js'
import styles from './AuthScreen.module.css'
import { PasswordToggle, TextField } from './TextField.js'

type LoginFormProps = {
  email: string
  onEmailChange: (value: string) => void
  onAuthenticated: (user: AuthUser) => void
  onSwitch: () => void
}

export const LoginForm = ({ email, onEmailChange, onAuthenticated, onSwitch }: LoginFormProps) => {
  const t = useTranslate()
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) {
      return
    }
    setError(null)
    if (!email.trim() || !password) {
      setError('邮箱和密码都要填')
      ;(email.trim() ? passwordRef : emailRef).current?.focus()
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

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <TextField
        label={t('authEmail')}
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder={t('authEmailPlaceholder')}
        value={email}
        onChange={(event) => onEmailChange(event.target.value)}
        inputRef={emailRef}
      />
      <TextField
        label={t('authPassword')}
        type={shown ? 'text' : 'password'}
        autoComplete="current-password"
        placeholder={t('authPasswordPlaceholder')}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        inputRef={passwordRef}
        state={submitting ? 'loading' : 'default'}
        trailing={<PasswordToggle shown={shown} onToggle={() => setShown((value) => !value)} />}
      />
      {error ? (
        <div className={styles.msgRow} role="alert" aria-live="assertive">
          <span className={styles.error}>{error}</span>
        </div>
      ) : null}
      <button
        type="submit"
        className={styles.submit}
        disabled={submitting}
        aria-busy={submitting ? true : undefined}
      >
        {submitting ? <span className={styles.spinner} aria-hidden="true" /> : null}
        {t('authLoginSubmit')}
      </button>
      <div className={styles.switchRow}>
        <span>{t('authNoAccount')}</span>
        <button type="button" className={styles.switchLink} onClick={onSwitch}>
          {t('authGoRegister')}
        </button>
      </div>
    </form>
  )
}
