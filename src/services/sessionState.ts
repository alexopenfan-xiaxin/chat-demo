import { create } from 'zustand'

/**
 * 会话过期只影响发送：横幅常驻，输入框和草稿都不动，
 * 所以这个状态放在全局，输入区和 App 都能读。
 */
type SessionState = { expired: boolean }

export const useSessionState = create<SessionState>(() => ({ expired: false }))

export const setSessionExpired = (expired: boolean) => {
  useSessionState.setState({ expired })
}
