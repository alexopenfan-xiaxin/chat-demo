/**
 * 记忆入口的大脑图标。
 *
 * 为什么单独一个组件：三处（侧边栏 16、提示条与动作记录 14、页面 Hero 20）共用同一份
 * path，线宽按 `1.45 × 16 / size` 推算——项目惯用的 1.2 在 16px 上会把四条线糊成
 * 「圆点加十字」，1.45 才看得出轮廓起伏与中缝。见
 * /root/work/ds-chat-brain-icon-and-tool-hint.md。
 *
 * 16px 下它的观感是「有起伏的圆 + 中缝」，不是解剖学大脑；这是与侧边栏其它线稿图标
 * 保持同一视觉重量的取舍，用户看到的语境还有「记忆」两个字在旁边。
 */
export const IconBrain = ({ size = 16, className }: { size?: number; className?: string }) => {
  const strokeWidth = (1.45 * 16) / size
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M8 2.8C9.5 2.8 10.8 3.4 11.3 4.5C12.3 4.7 13 5.5 13 6.4C13 6.9 12.8 7.4 12.5 7.7C12.9 8.2 12.9 8.9 12.6 9.4C12.2 10.2 11.3 10.7 10.4 10.5C9.9 11.3 9 11.8 8 11.8C7 11.8 6.1 11.3 5.6 10.5C4.7 10.7 3.8 10.2 3.4 9.4C3.1 8.9 3.1 8.2 3.5 7.7C3.2 7.4 3 6.9 3 6.4C3 5.5 3.7 4.7 4.7 4.5C5.2 3.4 6.5 2.8 8 2.8Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 2.8V10" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
      <path
        d="M5.5 6.2c.6-.4 1.3-.4 1.9 0"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d="M8 8.2c.6-.4 1.3-.4 1.9 0"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  )
}
