/**
 * 账号切换时要一起掐断的后台请求。
 *
 * 聊天流自己有 `streaming` 表可以中止，但摘要压缩、记忆重算、记忆工具算向量这些
 * 后台请求不在那张表里：它们的 controller 多半是局部变量，切号后没人能停。
 * 这一层只做一件事——登记，然后在切号时全部 abort。
 */
const controllers = new Set<AbortController>()

export const trackRequest = (controller: AbortController): AbortController => {
  controllers.add(controller)
  return controller
}

export const untrackRequest = (controller: AbortController): void => {
  controllers.delete(controller)
}

export const abortTrackedRequests = (): void => {
  for (const controller of controllers) {
    controller.abort()
  }
  controllers.clear()
}
