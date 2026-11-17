import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { AuthUser } from '../../services/auth.js'
import styles from './AuthScreen.module.css'
import { LoginForm } from './LoginForm.js'
import { RegisterForm } from './RegisterForm.js'

type AuthScreenProps = {
  onAuthenticated: (user: AuthUser) => void
}

/** 登录 / 注册的容器：居中卡片 + 两条流程切换，邮箱在两者之间保留 */
export const AuthScreen = ({ onAuthenticated }: AuthScreenProps) => {
  const t = useTranslate()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="auth-title">
        <div className={styles.brandRow}>
          <span className={styles.brandMark} aria-hidden="true">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none">
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
          <span className={styles.subtitle}>ds-chat</span>
        </div>

        <h1 id="auth-title" className={styles.title}>
          {mode === 'login' ? t('authLoginTitle') : t('authRegisterTitle')}
        </h1>
        <p className={styles.subtitle}>
          {mode === 'login' ? t('authLoginSubtitle') : t('authRegisterSubtitle')}
        </p>

        {mode === 'login' ? (
          <LoginForm
            email={email}
            onEmailChange={setEmail}
            onAuthenticated={onAuthenticated}
            onSwitch={() => setMode('register')}
          />
        ) : (
          <RegisterForm
            email={email}
            onEmailChange={setEmail}
            onAuthenticated={onAuthenticated}
            onSwitch={() => setMode('login')}
          />
        )}
      </section>
    </main>
  )
}
