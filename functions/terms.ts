/** /terms：用户协议静态页。内容先给最小可用版本，法律文本由用户补。 */
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
      '用户协议',
      `<h1>用户协议</h1>
       <p class="meta">最后更新：2026-11-17</p>
       <p>ds-chat 是一个静态聊天示例应用。使用本服务即表示你同意以下条款。</p>
       <h2>账号</h2>
       <p>你需要用邮箱注册并自行保管密码。账号下的活动由你负责。</p>
       <h2>使用规范</h2>
       <p>请勿利用本服务生成或传播违法内容，也请勿尝试绕过接口的鉴权与限流。</p>
       <h2>服务变更</h2>
       <p>功能可能随时调整或停止，恕不另行通知。</p>
       <p><a href="/">返回 ds-chat</a></p>`
    ),
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } }
  )
