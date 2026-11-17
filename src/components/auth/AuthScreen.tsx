import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { AuthUser } from '../../services/auth.js'
import styles from './AuthScreen.module.css'
import { LoginForm } from './LoginForm.js'
import { RegisterForm } from './RegisterForm.js'
import { TextField } from './TextField.js'

type AuthScreenProps = {
  onAuthenticated: (user: AuthUser) => void
}

const emailLooksValid = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())

/**
 * 版式见 ds-chat-auth-design-v2.md：没有卡片，logo 在上、身份在中、
 * 两个胶囊按钮在下，中间的余量全交给 spacer。
 */
export const AuthScreen = ({ onAuthenticated }: AuthScreenProps) => {
  const t = useTranslate()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [editingEmail, setEditingEmail] = useState(true)
  const [accepted, setAccepted] = useState(false)
  const [termsFlash, setTermsFlash] = useState(0)
  const [emailError, setEmailError] = useState<string | null>(null)
  const emailRef = useRef<HTMLInputElement>(null)

  /** 提交时以 DOM 为准：Safari 和部分密码管理器不会派发动画事件 */
  const readEmail = () => (emailRef.current?.value ?? email).trim()

  const syncFromAutofill = (event: { animationName?: string; currentTarget: HTMLInputElement }) => {
    if (event.animationName === 'onAutoFillStart') {
      setEmail(event.currentTarget.value)
      setEmailError(null)
    }
  }

  /**
   * 把当前邮箱落到 state。必须优先读 DOM：autofill 只写 DOM，state 还是空串；
   * 而用户点勾选协议时 input 会 blur，那一刻 DOM 里的值还在，读它能补上 state，
   * 后续重渲染才不会把 autofill 的值冲掉。
   */
  const commitEmail = (override?: string) => {
    const value = (override ?? readEmail()).trim()
    if (!value) {
      return false
    }
    if (!emailLooksValid(value)) {
      setEmailError(t('authEmailInvalid'))
      emailRef.current?.focus()
      return false
    }
    setEmail(value)
    setEmailError(null)
    setEditingEmail(false)
    return true
  }

  const requestEmail = () => {
    setEditingEmail(true)
    window.requestAnimationFrame(() => emailRef.current?.focus())
  }

  return (
    <main className={styles.page}>
      <div className={styles.content}>
        <header className={styles.head}>
          <span className={styles.brandMark} aria-hidden="true">
            <svg viewBox="0 0 20 20" width="22" height="22" fill="none">
              <path
                d="M4 5.5h12v7.2a1.8 1.8 0 0 1-1.8 1.8H8.2L5 17v-2.5H5.8A1.8 1.8 0 0 1 4 12.7Z"
                fill="currentColor"
                fillOpacity=".18"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <path d="M7.2 8.4h5.6M7.2 11h3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </span>
          <h1 className={styles.wordmark}>{t('authWordmark')}</h1>
        </header>

        <div className={styles.spacer} />

        <div className={styles.identity}>
          {editingEmail ? (
            <TextField
              label={t('authEmail')}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder={t('authEmailPlaceholder')}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onBlur={() => commitEmail()}
              onAnimationStart={syncFromAutofill}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitEmail()
                }
              }}
              inputRef={emailRef}
              state={emailError ? 'error' : 'default'}
              message={emailError}
            />
          ) : (
            <>
              <p className={styles.identityEmail} title={email}>
                {email}
              </p>
              <button type="button" className={styles.changePill} onClick={requestEmail}>
                <span className={styles.changePillLabel}>{t('authChange')}</span>
              </button>
            </>
          )}
        </div>

        <p className={styles.subline}>{mode === 'login' ? t('authSublineLogin') : t('authSublineRegister')}</p>

        {mode === 'login' ? (
          <LoginForm
            accepted={accepted}
            termsFlash={termsFlash}
            onAccept={setAccepted}
            onSwitch={() => setMode('register')}
            onRequestEmail={requestEmail}
            readEmail={readEmail}
            commitEmail={commitEmail}
            onBlockedByTerms={() => setTermsFlash((value) => value + 1)}
            onAuthenticated={onAuthenticated}
          />
        ) : (
          <RegisterForm
            accepted={accepted}
            termsFlash={termsFlash}
            onAccept={setAccepted}
            onSwitch={() => setMode('login')}
            onRequestEmail={requestEmail}
            readEmail={readEmail}
            commitEmail={commitEmail}
            onBlockedByTerms={() => setTermsFlash((value) => value + 1)}
            onAuthenticated={onAuthenticated}
          />
        )}
      </div>
    </main>
  )
}
