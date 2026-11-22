import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * 本机设置，存 localStorage：语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态。
 *
 * 这里曾经存过用户填的 API Key。现在 key 由服务端按会话注入，浏览器不再需要它，
 * 所以字段删掉，并在初始化时把老版本留下的那份明文从 localStorage 里清掉。
 */
type Settings = {
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  /** 记忆功能：默认关闭，关闭时不声明工具、不检索、不注入，请求体与没有这个功能时一致 */
  memory: boolean
}

const KEYS = {
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  memory: 'chat-demo:memory',
} as const

/**
 * 账号作用域：跟着人走的开关（思考、搜索、记忆）按 `:<user.id>` 分键存，
 * 主题、语言、字号、侧栏这些纯外观留在全局键上——换账号不该把界面翻个底朝天。
 *
 * 没登录时作用域为空：这些开关只用内存里的默认值，不读也不写全局键，
 * 免得「A 退出后 B 还没登录」的窗口把 A 的偏好写坏。
 */
let settingsScope: string | null = null

const SCOPED: ReadonlySet<string> = new Set(['thinking', 'search', 'memory'])

const scopedKey = (base: string, field: string): string | null =>
  SCOPED.has(field) ? (settingsScope ? `${base}:${settingsScope}` : null) : base

/** 切换账号：重新按新作用域读一遍开关，外观项保持不动 */
export const setSettingsScope = (userId: string | null): void => {
  settingsScope = userId
  useSettings.setState({
    thinking: readSetting('thinking') === 'true',
    search: readSetting('search') === 'true',
    memory: readSetting('memory') === 'true',
  })
}

const readSetting = (field: 'thinking' | 'search' | 'memory'): string | null => {
  const key = scopedKey(KEYS[field], field)
  return key ? read(key) : null
}

const writeSetting = (field: 'thinking' | 'search' | 'memory', value: boolean): void => {
  const key = scopedKey(KEYS[field], field)
  if (key) {
    write(key, String(value))
  }
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean => {
  // 取不到浏览器语言时按中文处理：这是中文产品的默认面
  const lang = typeof navigator === 'undefined' ? '' : navigator.language || ''
  if (!lang) {
    return true
  }
  return lang.toLowerCase().startsWith('zh')
}

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 老版本存的是 stella / tide，映射到 Edge TTS 的晓晓 / 云希，别让设置变空值 */
const LEGACY_VOICES: Record<string, TtsVoice> = {
  stella: 'xiaoxiao',
  tide: 'yunxi',
}

const VOICE_IDS: TtsVoice[] = ['xiaoxiao', 'yunxi', 'xiaoyi', 'yunyang']

/** 未保存过时用晓晓：语速断句最稳，长文朗读耐听 */
const initialTtsVoice = (): TtsVoice => {
  const saved = read(KEYS.ttsVoice) ?? ''
  const migrated = LEGACY_VOICES[saved] ?? saved
  return VOICE_IDS.includes(migrated as TtsVoice) ? (migrated as TtsVoice) : 'xiaoxiao'
}

export const useSettings = create<Settings>(() => ({
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  // 三个开关跟着账号走，登录前一律按默认（关）显示
  thinking: false,
  search: false,
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  // 默认关闭：记忆要用户自己打开才开始采集与召回
  memory: false,
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

/** 一次性清理老版本留在浏览器里的明文 key */
export const purgeLegacyApiKey = () => {
  try {
    localStorage.removeItem('chat-demo:api-key')
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export const setThinking = (thinking: boolean) => {
  writeSetting('thinking', thinking)
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  writeSetting('search', search)
  useSettings.setState({ search })
}

export const setMemory = (memory: boolean) => {
  writeSetting('memory', memory)
  useSettings.setState({ memory })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
