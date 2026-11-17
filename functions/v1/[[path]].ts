/**
 * /v1/* 同源转发。
 *
 * 浏览器端只会请求本站的 /v1/...：同源既绕开上游的 CORS 白名单，
 * 也避免 https 页面直连 http 接口时的混合内容拦截。
 * 上游由环境变量 CHAT_API_UPSTREAM 指定，默认指向本机的中转服务。
 */

type Env = { CHAT_API_UPSTREAM?: string }

const DEFAULT_UPSTREAM = 'http://43.143.237.221:18787'

/** 逐跳首部与由运行时代管的首部不能透传 */
const DROP_HEADERS = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length']

export const onRequest = async (context: {
  request: Request
  env: Env
}): Promise<Response> => {
  const { request, env } = context
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, accept',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      },
    })
  }
  const upstream = (env.CHAT_API_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, '')
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  for (const name of DROP_HEADERS) {
    headers.delete(name)
  }
  let response: Response
  try {
    response = await fetch(upstream + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    })
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: { message: `转发失败：${error instanceof Error ? error.message : String(error)}` },
      }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } }
    )
  }
  const out = new Headers(response.headers)
  for (const name of DROP_HEADERS) {
    out.delete(name)
  }
  // 流式回答不能缓存，也不能让中间层压缩后攒批
  out.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, headers: out })
}
