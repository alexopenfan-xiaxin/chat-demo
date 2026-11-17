/**
 * 站点级安全头。
 *
 * CSP 只放不做排版的那几条：登录卡片不能被任何站点嵌 iframe（clickjacking 诱导输密码），
 * 表单只能提交到本站，插件/object 一律不许。**故意不写 default-src / script-src**：
 * 页面要加载 Turnstile 的脚本，收紧脚本源得连带维护白名单，先不在这里赌。
 * X-Frame-Options 给不认 frame-ancestors 的老浏览器兜底，HSTS 只在 https 上加。
 */

const CSP = "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"

export const onRequest = async (context: {
  request: Request
  next: () => Promise<Response>
}): Promise<Response> => {
  const response = await context.next()
  const headers = new Headers(response.headers)

  if (!headers.has('content-security-policy')) {
    headers.set('content-security-policy', CSP)
  }
  if (!headers.has('x-frame-options')) {
    headers.set('x-frame-options', 'DENY')
  }
  if (!headers.has('x-content-type-options')) {
    headers.set('x-content-type-options', 'nosniff')
  }
  if (!headers.has('referrer-policy')) {
    headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  }
  if (!headers.has('strict-transport-security') && new URL(context.request.url).protocol === 'https:') {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains')
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
