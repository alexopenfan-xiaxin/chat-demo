import clsx from 'clsx'
import styles from './Switch.module.css'

/**
 * 开关：原生 button + role="switch"，键盘可聚焦、空格可切换。
 * 尺寸与配色跟随现有界面色调（主色 #2B63F0），没有单独的动画。
 */
export const Switch = ({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  /** 无障碍名称；旁边的可见文字仍然要在外面写 */
  label: string
  onChange: (checked: boolean) => void
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    className={clsx(styles.switch, checked && styles.on, disabled && styles.disabled)}
    onClick={() => onChange(!checked)}
  >
    <span className={styles.knob} />
  </button>
)
