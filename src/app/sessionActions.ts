/**
 * 退出登录的入口从侧边栏挪到了设置页，但登录状态归 App 管。
 * 这里只放一个回调登记处：App 启动时把 onLogout 注册进来，设置页确认后调用。
 */
let logoutHandler: (() => Promise<void>) | null = null

export const setLogoutHandler = (handler: (() => Promise<void>) | null) => {
  logoutHandler = handler
}

export const performLogout = async () => {
  await logoutHandler?.()
}
