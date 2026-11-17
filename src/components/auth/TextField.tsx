import clsx from 'clsx'
import { useId } from 'react'
import type { InputHTMLAttributes, ReactNode, Ref } from 'react'
import { useTranslate } from '../../i18n/index.js'
import styles from './AuthScreen.module.css'

export type FieldState = 'default' | 'error' | 'loading' | 'success'

type TextFieldProps = {
  label: string
  /** 错误 / 加载 / 成功决定边框与光环；错误文本走 message */
  state?: FieldState
  message?: string | null
  hint?: string | null
  /** 密码框右侧的显示/隐藏按钮等 */
  trailing?: ReactNode
  inputRef?: Ref<HTMLInputElement>
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id'>

/** label + 输入框 + 固定高度消息行；消息行常驻，避免报错时整块表单跳动 */
export const TextField = ({
  label,
  state = 'default',
  message,
  hint,
  trailing,
  inputRef,
  ...input
}: TextFieldProps) => {
  const id = useId()
  const messageId = `${id}-message`
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.inputWrap}>
        <input
          {...input}
          id={id}
          ref={inputRef}
          className={clsx(
            styles.input,
            trailing ? styles.inputWithEye : undefined,
            state === 'error' && styles.hasError,
            state === 'success' && styles.isSuccess
          )}
          aria-invalid={state === 'error' ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          aria-busy={state === 'loading' ? true : undefined}
        />
        {state === 'loading' ? (
          <span className={styles.fieldSpinner}>
            <span className={styles.spinner} aria-hidden="true" />
          </span>
        ) : null}
        {trailing}
      </div>
      <div className={styles.msgRow}>
        {message ? (
          <span id={messageId} className={styles.error} role="alert">
            {message}
          </span>
        ) : hint ? (
          <span className={styles.hint}>{hint}</span>
        ) : null}
      </div>
    </div>
  )
}

/** 密码框右侧的眼睛按钮：36×36 点击区，aria-pressed 同步 */
export const PasswordToggle = ({ shown, onToggle }: { shown: boolean; onToggle: () => void }) => {
  const t = useTranslate()
  return (
  <button
    type="button"
    className={styles.eye}
    aria-pressed={shown}
    aria-label={shown ? t('authHidePassword') : t('authShowPassword')}
    onClick={onToggle}
  >
    {shown ? (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
        <path
          d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.3" />
        <path d="M3 13 13 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ) : (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
        <path
          d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    )}
  </button>
  )
}
