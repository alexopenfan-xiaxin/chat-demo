import { currentUser, guarded, json, takeRateLimit, type Env } from '../../server/auth-core'

/**
 * POST /api/title：给会话起一个像人写的标题。
 *
 * 上游三种协议都不带「生成标题」能力，所以这条是我们自己补的：首轮回答结束后，
 * 前端把用户的问题发过来，这里用一把**全站共用、不限额、只绑 minimax-m3.1-flash**
 * 的服务端 key 打一个小请求，让模型写一句概括。
 *
 * 三个必须守住的点：
 * 1. key 只在服务端（`TITLE_SUMMARY_KEY`），响应里只回标题，浏览器接触不到；
 * 2. 走 proxy 的 `/internal/v1/*` 内部通道——直接打 `/v1` 会被换成当前用户自己的 key，
 *    那就变成用用户的钱生成标题了；
 * 3. 失败、超时、限流一律回空标题，前端保留本地截断，用户无感。
 */

type TitleEnv = Env & {
  UPSTREAM_BASE?: string
  INTERNAL_API_SECRET?: string
  TITLE_SUMMARY_KEY?: string
}

const MODEL = 'minimax-m3.1-flash'
const TIMEOUT_MS = 8000
/** 每个用户每小时最多让模型起 30 次标题，防止有人拿它当免费模型刷 */
const RATE_LIMIT = 30
const RATE_WINDOW = 3600
const TITLE_LIMIT = 24

const hasCjk = (text: string) => /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)

/** 模型不一定听话：去掉包裹引号、末尾标点、多余空白，再按 24 字硬截断 */
export const sanitiseTitle = (raw: string): string => {
  let title = raw.replace(/\s+/g, ' ').trim()
  // 整句被引号包住的情况最常见，成对剥
  title = title.replace(/^[「『"'“”‘’《【(（]+/, '').replace(/[」』"'“”‘’》】)）]+$/, '')
  title = title.replace(/[\s,.;:!?，。；：！？、·\-—]+$/u, '').trim()
  if (!title) {
    return ''
  }
  const chars = [...title]
  if (hasCjk(title)) {
    return chars.length > TITLE_LIMIT ? `${chars.slice(0, TITLE_LIMIT).join('')}` : title
  }
  return title.length > TITLE_LIMIT * 2 ? title.slice(0, TITLE_LIMIT * 2).trimEnd() : title
}

/** 从 Responses 结构里取正文；思考块不算 */
const readText = (payload: unknown): string => {
  if (typeof payload !== 'object' || payload === null) {
    return ''
  }
  const output = (payload as { output?: unknown }).output
  if (!Array.isArray(output)) {
    return ''
  }
  const parts: string[] = []
  for (const item of output) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) {
      continue
    }
    for (const piece of content) {
      if (typeof piece === 'object' && piece !== null && typeof (piece as { text?: unknown }).text === 'string') {
        parts.push((piece as { text: string }).text)
      }
    }
  }
  return parts.join(' ').trim()
}

export const onRequestPost = guarded(async (context: { request: Request; env: TitleEnv }) => {
  const { request, env } = context
  const user = await currentUser(request, env.DB)
  if (!user) {
    return json({ error: '请先登录' }, 401)
  }
  let body: { question?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: '请求格式不对' }, 400)
  }
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 500) : ''
  if (!question) {
    return json({ title: '' })
  }
  if (!(await takeRateLimit(env.DB, `title:${user.user.id}`, RATE_LIMIT, RATE_WINDOW))) {
    return json({ title: '' }, 429)
  }
  const key = env.TITLE_SUMMARY_KEY
  const internal = env.INTERNAL_API_SECRET
  if (!key || !internal) {
    // 没配就当没这个功能，前端保留本地标题
    return json({ title: '' }, 503)
  }

  const base = (env.UPSTREAM_BASE ?? 'https://api-ds-chat.openfan.dpdns.org').replace(/\/+$/, '')
  try {
    const response = await fetch(`${base}/internal/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        // 走内部通道的门票；proxy 只对 /internal/ 和 /api/ 认这个头
        'x-internal-secret': internal,
      },
      body: JSON.stringify({
        model: MODEL,
        max_output_tokens: 400,
        // 实测：不带 reasoning 反而要 11.8 秒，thinking:disabled 不生效
        reasoning: { effort: 'low' },
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `用不超过12个字概括下面这个问题，只输出标题本身，不要标点，不要解释：\n${question}`,
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      return json({ title: '' }, 502)
    }
    const payload = (await response.json()) as unknown
    return json({ title: sanitiseTitle(readText(payload)) })
  } catch {
    // 超时或网络失败：标题留空，用户继续看到本地截断，不报错
    return json({ title: '' }, 504)
  }
})
