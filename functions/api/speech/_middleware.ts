import { json } from '../../../server/auth-core'

/** 只做方法收口；会话校验放在各 handler 里，统一走 guarded 的异常兜底 */
export const onRequest = async (context: {
  request: Request
  next: () => Promise<Response>
}): Promise<Response> => {
  if (context.request.method !== 'POST') {
    return json({ error: '只支持 POST' }, 405)
  }
  return context.next()
}
