import { create } from 'zustand'

/**
 * 会话过期只影响发送：横幅常驻，输入框和草稿都不动，
 * 所以这个状态放在全局，输入区和 App 都能读。
 */
type SessionState = {
  /** 会话失效：常驻横幅，用户重新登录才消失 */
  expired: boolean
  /** 校验服务不可用（proxy 503）：中性横幅，15 秒自动收起，不自动重试 */
  unavailable: boolean
}

export const useSessionState = create<SessionState>(() => ({ expired: false, unavailable: false }))

export const setSessionExpired = (expired: boolean) => {
  useSessionState.setState({ expired })
}

export const setServiceUnavailable = (unavailable: boolean) => {
  useSessionState.setState({ unavailable })
}
