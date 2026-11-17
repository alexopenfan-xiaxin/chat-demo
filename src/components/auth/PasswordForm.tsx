import { useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { AuthError } from '../../services/auth.js'
import styles from './AuthScreen.module.css'
import { PasswordToggle, TextField } from './TextField.js'

/** §14.1：三个入口（忘记密码 / 侧边栏改密码 / 重置链接）共用这一套渲染 */
export type PasswordFieldName = 'current' | 'password' | 'confirm'

export type PasswordValues = { current?: string; password: string; confirm?: string }

type PasswordFormProps = {
  /** 决定字段组合，别在外面各写一套 */
  fields: PasswordFieldName[]
  submitLabel: string
  /** 提交时把值交给调用方；返回的 updatedAt 必须来自服务端 */
  onSubmit: (values: PasswordValues) => Promise<{ updatedAt: string }>
  /** 成功块里的次要按钮（已登录入口才有「返回聊天」） */
  doneActionLabel?: string
  onDoneAction?: () => void
}

const formatStamp = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 改密码 / 重置密码的表单；成功态停在原地，不自动跳走（§14.2） */
export const PasswordForm = ({
  fields,
  submitLabel,
  onSubmit,
  doneActionLabel,
  onDoneAction,
}: PasswordFormProps) => {
  const t = useTranslate()
  const [values, setValues] = useState<PasswordValues>({ current: '', password: '', confirm: '' })
  const [shown, setShown] = useState(false)
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<PasswordFieldName | 'form', string>>>({})
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  const set = (name: PasswordFieldName, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }))
    setErrors((prev) => ({ ...prev, [name]: undefined }))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) {
      return
    }
    const next: Partial<Record<PasswordFieldName | 'form', string>> = {}
    if (fields.includes('current') && !values.current) {
      next.current = t('authPasswordCurrentRequired')
    }
    if (values.password.length < 8) {
      next.password = t('authPasswordTooShort')
    }
    if (fields.includes('confirm') && values.confirm !== values.password) {
      next.confirm = t('authPasswordMismatch')
    }
    if (Object.keys(next).length > 0) {
      setErrors(next)
      return
    }
    setPending(true)
    setErrors({})
    try {
      const result = await onSubmit(values)
      // 时间一律用服务端返回的那个，前端不自己 new Date()
      setUpdatedAt(result.updatedAt)
    } catch (error) {
      const message = error instanceof AuthError ? error.message : t('authNetwork')
      // §14.3：这几种必须落到各自的框，不能并成一句「操作失败」
      if (message.includes('当前密码')) {
        setErrors({ current: message })
        // 当前密码错时只清这一栏，新密码两栏留着
        setValues((prev) => ({ ...prev, current: '' }))
      } else if (message.includes('一样') || message.includes('至少')) {
        setErrors({ password: message })
      } else if (message.includes('次数')) {
        setErrors({ form: message })
      } else {
        setErrors({ form: message })
      }
    } finally {
      setPending(false)
    }
  }

  if (updatedAt) {
    return (
      <div className={styles.passwordSuccess}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true" className={styles.passwordSuccessIcon}>
          <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1.2" />
          <path d="m5.2 8.2 1.9 1.9 3.7-3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className={styles.passwordSuccessTitle}>{t('authPasswordUpdated')}</div>
        <div className={styles.passwordSuccessTime}>
          {t('authPasswordUpdatedAt', { time: formatStamp(updatedAt) })}
        </div>
        {doneActionLabel ? (
          <button type="button" className={styles.passwordDone} onClick={onDoneAction}>
            {doneActionLabel}
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <form className={styles.passwordForm} onSubmit={submit} noValidate>
      {fields.includes('current') ? (
        <TextField
          label={t('authPasswordCurrent')}
          type={shown ? 'text' : 'password'}
          value={values.current ?? ''}
          state={errors.current ? 'error' : 'default'}
          message={errors.current}
          autoComplete="current-password"
          trailing={<PasswordToggle shown={shown} onToggle={() => setShown(!shown)} />}
          onChange={(event) => set('current', event.target.value)}
        />
      ) : null}
      <TextField
        label={t('authPasswordNew')}
        type={shown ? 'text' : 'password'}
        value={values.password}
        state={errors.password ? 'error' : 'default'}
        message={errors.password}
        autoComplete="new-password"
        hint={fields.includes('confirm') ? undefined : t('authPasswordRule')}
        trailing={fields.includes('current') ? undefined : <PasswordToggle shown={shown} onToggle={() => setShown(!shown)} />}
        onChange={(event) => set('password', event.target.value)}
      />
      {fields.includes('confirm') ? (
        <TextField
          label={t('authPasswordConfirm')}
          type={shown ? 'text' : 'password'}
          value={values.confirm ?? ''}
          state={errors.confirm ? 'error' : 'default'}
          message={errors.confirm}
          autoComplete="new-password"
          onChange={(event) => set('confirm', event.target.value)}
        />
      ) : null}
      {errors.form ? (
        <div className={styles.passwordFormError} role="alert">
          {errors.form}
        </div>
      ) : null}
      <button type="submit" className={styles.passwordSubmit} aria-disabled={pending}>
        {pending ? t('authSubmitting') : submitLabel}
      </button>
    </form>
  )
}
