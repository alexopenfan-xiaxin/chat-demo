import lightSmall from '../../assets/whale/whale-light-64.webp'
import darkSmall from '../../assets/whale/whale-dark-64.webp'
import lightFull from '../../assets/whale/whale-light-256.webp'
import darkFull from '../../assets/whale/whale-dark-256.webp'
import styles from './BrandIcon.module.css'

type BrandIconProps = {
  /** 渲染边长（px）；都是两倍图按 CSS 缩到目标尺寸 */
  size: number
  /**
   * small：64px 源，给 24px 这类小尺寸（同一张图，缩下去轮廓还立得住）
   * large：256px 源，给 112px 这类大尺寸
   */
  source?: 'small' | 'large'
}

/**
 * 鲸鱼娘图标：浅色 / 深色两版都渲染，由 `[data-ds-dark-theme]` 在 CSS 里切换，
 * 不做 JS 判断。装饰性图片，alt 留空，避免读屏念出文件名。
 * 用 webp：同尺寸下比 png 小 70–80%，页面每主题只加载两张。
 */
export const BrandIcon = ({ size, source = 'large' }: BrandIconProps) => (
  <span className={styles.wrap} style={{ width: size, height: size }} aria-hidden="true">
    <img
      className={styles.light}
      src={source === 'small' ? lightSmall : lightFull}
      width={size}
      height={size}
      alt=""
    />
    <img
      className={styles.dark}
      src={source === 'small' ? darkSmall : darkFull}
      width={size}
      height={size}
      alt=""
    />
  </span>
)
