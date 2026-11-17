import { create } from 'zustand'

/**
 * 额度弹窗的打开状态。
 *
 * 入口有两个（侧边栏底部按钮、错误提示里的操作），所以状态提到模块级，
 * 不再由侧边栏私有 useState 持有。
 */
export const useCreditsDialog = create(() => ({ open: false }))

export const openCredits = () => useCreditsDialog.setState({ open: true })
export const closeCredits = () => useCreditsDialog.setState({ open: false })
