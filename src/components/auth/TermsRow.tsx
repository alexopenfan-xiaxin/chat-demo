import { useTranslate } from '../../i18n/index.js'
import styles from './AuthScreen.module.css'

type TermsRowProps = {
  accepted: boolean
  onChange: (accepted: boolean) => void
  /** 每次点击被协议拦下的主按钮就加一，用来闪一下这行 */
  flashToken: number
  /** 上方有「忘记密码？」链接时，间距收窄到 12px */
  compact?: boolean
}

/** 协议行：圆 + 文字整行可点，协议名打开新标签 */
export const TermsRow = ({ accepted, onChange, flashToken, compact }: TermsRowProps) => {
  const t = useTranslate()
  return (
    <div
      // 只靠 flashToken 触发一次性动画，关掉重开同一行不会累加
      key={flashToken}
      className={[
        styles.terms,
        compact ? styles.termsCompact : '',
        flashToken > 0 ? styles.termsFlash : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={accepted}
        aria-label={t('authTermsAccept')}
        className={styles.termsCircle}
        onClick={() => onChange(!accepted)}
      >
        {accepted ? (
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
            <path
              d="m3.5 8.4 3 3 6-6.4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </button>
      <span className={styles.termsText}>
        {t('authTermsPrefix')}
        <button type="button" className={styles.termsLink} onClick={() => window.open('/terms', '_blank', 'noopener')}>
          {t('authTermsUser')}
        </button>
        {t('authTermsAnd')}
        <button
          type="button"
          className={styles.termsLink}
          onClick={() => window.open('/privacy', '_blank', 'noopener')}
        >
          {t('authTermsPrivacy')}
        </button>
      </span>
    </div>
  )
}
