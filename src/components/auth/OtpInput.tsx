import clsx from 'clsx'
import { useCallback, useEffect, useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import styles from './AuthScreen.module.css'

type OtpInputProps = {
  /** 定长数组，空格子用空字符串 */
  value: string[]
  onChange: (next: string[]) => void
  /** 六格填满时触发一次，用来把焦点交给提交按钮（不自动提交） */
  onComplete?: () => void
  invalid?: boolean
  success?: boolean
  disabled?: boolean
  autoFocus?: boolean
}

const onlyDigits = (text: string, limit: number) => text.replace(/\D/g, '').slice(0, limit)

/** 六格验证码：自动前移、退格回退、整段粘贴、方向键移动 */
export const OtpInput = ({
  value,
  onChange,
  onComplete,
  invalid,
  success,
  disabled,
  autoFocus,
}: OtpInputProps) => {
  const t = useTranslate()
  const refs = useRef<Array<HTMLInputElement | null>>([])

  useEffect(() => {
    if (autoFocus && !disabled) {
      refs.current[0]?.focus()
    }
  }, [autoFocus, disabled])

  const write = useCallback(
    (next: string[]) => {
      onChange(next)
      if (next.every((digit) => digit !== '')) {
        onComplete?.()
      }
    },
    [onChange, onComplete]
  )

  const focusAt = (index: number) => {
    const target = refs.current[Math.max(0, Math.min(index, value.length - 1))]
    target?.focus()
    target?.select()
  }

  const setDigit = (index: number, raw: string) => {
    const next = value.slice()
    const digits = onlyDigits(raw, value.length)
    if (digits.length === 0) {
      next[index] = ''
      write(next)
      return
    }
    // 一次贴进多位的输入（移动端输入法）按顺序摊到后面的格子
    for (let offset = 0; index + offset < value.length && offset < digits.length; offset += 1) {
      next[index + offset] = digits[offset]
    }
    write(next)
    focusAt(index + digits.length)
  }

  return (
    <div className={styles.otpRow} role="group" aria-label={t('authCodeLabel')}>
      {value.map((digit, index) => (
        <input
          // 固定 6 格，下标即身份
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          ref={(node) => {
            refs.current[index] = node
          }}
          className={clsx(styles.otpCell, invalid && styles.hasError, success && styles.isSuccess)}
          value={digit}
          onChange={(event) => setDigit(index, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Backspace') {
              if (value[index] === '') {
                event.preventDefault()
                const next = value.slice()
                next[index - 1] = ''
                write(next)
                focusAt(index - 1)
              } else {
                const next = value.slice()
                next[index] = ''
                write(next)
              }
              return
            }
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              focusAt(index - 1)
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              focusAt(index + 1)
            }
          }}
          onPaste={(event) => {
            const digits = onlyDigits(event.clipboardData.getData('text'), value.length)
            if (digits.length === 0) {
              return
            }
            event.preventDefault()
            const next = Array.from({ length: value.length }, () => '')
            for (let offset = 0; offset < digits.length; offset += 1) {
              next[offset] = digits[offset]
            }
            write(next)
            focusAt(digits.length)
          }}
          onFocus={(event) => event.target.select()}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={1}
          disabled={disabled}
          aria-label={t('authOtpDigit', { index: index + 1 })}
          aria-invalid={invalid ? true : undefined}
        />
      ))}
    </div>
  )
}
