import { create } from 'zustand'

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = 'general' | 'data'

/**
 * 打开后要滚到并短暂高亮的那一行：目前只有「记忆开关」用到——
 * 记忆关闭时 /memory 页的引导态点「去设置打开」，要落到开关本身上，而不是只弹个通用设置。
 */
export type SettingsFocus = 'memory'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
  focus: null as SettingsFocus | null,
}))

export const openSettings = (section: SettingsSection, focus: SettingsFocus | null = null) =>
  useSettingsDialog.setState({ open: true, section, focus })

/** 跳转目标用过就清掉，免得下次开设置又滚一次 */
export const clearSettingsFocus = () => useSettingsDialog.setState({ focus: null })

export const closeSettings = () => useSettingsDialog.setState({ open: false, focus: null })

/**
 * 发送前不再要求用户填 API Key：每个账号的上游 key 由服务端按会话注入，
 * 用户全程接触不到。保留这个函数名，调用点不用改。
 */
export const ensureApiKey = () => true
