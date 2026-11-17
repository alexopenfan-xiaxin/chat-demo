/**
 * 认证接口的统一前置检查。两件事：
 *
 * 1) **强制 application/json**。`request.json()` 不看你声明的 content-type，
 *    任何第三方页面都能用 `no-cors` + `text/plain` 把 JSON 塞进来，不触发预检。
 * 2) **校验 Origin / Sec-Fetch-Site**。写接口（POST）如果来自别的站点就拒掉，
 *    否则可以拿访客的浏览器做 login CSRF：把人悄悄登进攻击者的号里。
 *    浏览器对同源 POST 也会带 Origin，所以「带了就必须等于本站」是可行且够用的判据；
 *    curl / 服务间调用不带这些头，照常放行。
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const reject = (message: string, status: number): Response =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

export const onRequest = async (context: {
  request: Request
  next: () => Promise<Response>
}): Promise<Response> => {
  const { request } = context
  if (SAFE_METHODS.has(request.method)) {
    return context.next()
  }

  const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase()
  if (!contentType.startsWith('application/json')) {
    return reject('只接受 application/json 请求', 415)
  }

  // cross-site / same-site（不同子域）都算跨站；none 是地址栏直达，交给下面的 Origin 判
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') {
    return reject('跨站请求已拒绝', 403)
  }

  const origin = request.headers.get('origin')
  if (origin) {
    let expected: string
    try {
      expected = new URL(request.url).origin
    } catch {
      return reject('请求地址不合法', 400)
    }
    if (origin !== expected) {
      return reject('跨站请求已拒绝', 403)
    }
  }

  return context.next()
}
