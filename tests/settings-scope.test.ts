import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

const installStorage = () => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  })
  return store
}

const settings = await import('../src/services/settings')

const A = '11111111-2222-3333-4444-555555555555'
const B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('设置按账号分区', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = installStorage()
    settings.setSettingsScope(null)
  })

  it('跟着账号走的三项按 user.id 分键', () => {
    settings.setSettingsScope(A)
    settings.setMemory(true)
    settings.setThinking(true)
    settings.setSearch(true)
    expect(store.has(`chat-demo:memory:${A}`)).toBe(true)
    expect(store.has(`chat-demo:thinking:${A}`)).toBe(true)
    expect(store.has(`chat-demo:search:${A}`)).toBe(true)
    // 不再写全局键
    expect(store.has('chat-demo:memory')).toBe(false)
  })

  it('切到 B 后读不到 A 的开关', () => {
    settings.setSettingsScope(A)
    settings.setMemory(true)
    settings.setSettingsScope(B)
    expect(settings.useSettings.getState().memory).toBe(false)
    expect(settings.useSettings.getState().thinking).toBe(false)
  })

  it('纯外观项留在全局键上，切账号不翻主题', () => {
    settings.setSettingsScope(A)
    settings.setThemePreference('dark')
    settings.setSettingsScope(B)
    expect(store.get('chat-demo:theme-preference')).toBe('dark')
    expect(settings.useSettings.getState().themePreference).toBe('dark')
  })

  it('未登录时不读不写这些键', () => {
    settings.setMemory(true)
    expect([...store.keys()].some((key) => key.startsWith('chat-demo:memory'))).toBe(false)
  })
})
