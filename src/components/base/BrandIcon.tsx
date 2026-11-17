import lightSmall from '../../assets/whale/whale-light-128.png'
import darkSmall from '../../assets/whale/whale-dark-128.png'
import lightLarge from '../../assets/whale/whale-light-256.png'
import darkLarge from '../../assets/whale/whale-dark-256.png'
import styles from './BrandIcon.module.css'

type BrandIconProps = {
  /** 渲染边长（px）；两倍图按 CSS 缩到目标尺寸 */
  size: number
  /** small 用 128 源，large 用 256 源 */
  source?: 'small' | 'large'
}

/**
 * 鲸鱼娘图标：浅色 / 深色两版都渲染，由 `[data-ds-dark-theme]` 在 CSS 里切换，
 * 不做 JS 判断。装饰性图片，alt 留空，避免读屏念出文件名。
 */
export const BrandIcon = ({ size, source = 'small' }: BrandIconProps) => (
  <span className={styles.wrap} style={{ width: size, height: size }} aria-hidden="true">
    <img
      className={styles.light}
      src={source === 'small' ? lightSmall : lightLarge}
      width={size}
      height={size}
      alt=""
    />
    <img
      className={styles.dark}
      src={source === 'small' ? darkSmall : darkLarge}
      width={size}
      height={size}
      alt=""
    />
  </span>
)
