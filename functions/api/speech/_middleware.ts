import { currentUser, json, type Env } from '../../../server/auth-core'

/** 语音接口只给登录用户用：没有会话就 401，别让匿名用户拿它刷配额 */
export const onRequest = async (context: {
  request: Request
  env: Env
  next: () => Promise<Response>
}): Promise<Response> => {
  const { request, env } = context
  if (request.method !== 'POST') {
    return json({ error: '只支持 POST' }, 405)
  }
  const session = await currentUser(request, env.DB)
  if (!session) {
    return json({ error: '请先登录' }, 401)
  }
  return context.next()
}
