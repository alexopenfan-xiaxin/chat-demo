import { currentUser, guarded, json, type Env } from '../../../server/auth-core'

/**
 * POST /api/speech/asr：multipart 上传录音，调 Cloudflare 的 whisper。
 *
 * 不用 AI binding：它会把二进制音频序列化成字符串，模型侧直接拒绝
 * （AiError 5006 "Type mismatch of '/audio'"）。REST 接口接受原始二进制 body，
 * 所以这里用一个只带 Workers AI 权限的窄 token 调 REST。
 */
type SpeechEnv = Env & { CF_AI_TOKEN?: string; CF_ACCOUNT_ID?: string }

/** 8 MiB 上限与 whisper 的输入体积限制对齐 */
const MAX_BYTES = 8 * 1024 * 1024
const MODEL = '@cf/openai/whisper-large-v3-turbo'

export const onRequestPost = guarded(async (context: { request: Request; env: SpeechEnv }) => {
  const { request, env } = context
  if (!(await currentUser(request, env.DB))) {
    return json({ error: '请先登录' }, 401)
  }
  if (!env.CF_AI_TOKEN || !env.CF_ACCOUNT_ID) {
    return json({ error: '语音识别没有配置' }, 503)
  }
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return json({ error: '请求格式不对' }, 400)
  }
  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return json({ error: '没有收到录音' }, 400)
  }
  if (file.size > MAX_BYTES) {
    return json({ error: '录音太长了' }, 413)
  }

  const audio = await file.arrayBuffer()
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${MODEL}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CF_AI_TOKEN}`,
        'content-type': file.type || 'audio/wav',
      },
      body: audio,
    }
  )
  if (!response.ok) {
    return json({ error: '语音识别失败了' }, response.status === 429 ? 429 : 503)
  }
  const payload = (await response.json()) as { result?: { text?: string } }
  const text = typeof payload.result?.text === 'string' ? payload.result.text.trim() : ''
  return json({ text })
})
