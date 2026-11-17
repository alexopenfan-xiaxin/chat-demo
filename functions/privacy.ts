/** /privacy：隐私政策静态页。内容先给最小可用版本，法律文本由用户补。 */
const page = (title: string, body: string) => `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · ds-chat</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 40px 20px; font: 15px/1.75 -apple-system, "Segoe UI", "PingFang SC", sans-serif;
         color: #1a1a1a; background: #fff; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 8px; }
  h2 { font-size: 16px; margin: 28px 0 8px; }
  p, li { color: #4a4a4a; }
  .meta { color: #8a8a8a; font-size: 13px; }
  a { color: #2b63f0; }
  @media (prefers-color-scheme: dark) {
    body { color: #f2f2f2; background: #151517; }
    p, li { color: #b8b8bd; }
    a { color: #4c7eff; }
  }
</style>
<main>${body}</main>
</html>`

export const onRequestGet = () =>
  new Response(
    page(
      '隐私政策',
      `<h1>隐私政策</h1>
       <p class="meta">最后更新：2026-11-17</p>
       <h2>我们收集什么</h2>
       <p>注册邮箱、密码的加盐哈希、会话记录（创建时间、过期时间、IP 与浏览器标识）。密码本身不落库。</p>
       <h2>用途</h2>
       <p>仅用于登录、会话校验与接口防滥用（限流计数）。</p>
       <h2>保存期限</h2>
       <p>会话最多保留 30 天；注册验证码 10 分钟后失效。</p>
       <h2>第三方</h2>
       <p>人机验证由 Cloudflare Turnstile 提供；验证码邮件经由本站的邮件中转发出。</p>
       <p><a href="/">返回 ds-chat</a></p>`
    ),
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } }
  )
