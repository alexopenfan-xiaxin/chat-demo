import { currentUser, guarded, json, type Env } from '../../../server/auth-core'

/** POST /api/speech/asr：multipart 上传录音，直接调 Cloudflare 的 whisper */
type SpeechEnv = Env & {
  AI?: { run: (model: string, input: { audio: number[] }) => Promise<{ text?: string }> }
}

/** 8 MiB 上限与 whisper 的输入体积限制对齐 */
const MAX_BYTES = 8 * 1024 * 1024

export const onRequestPost = guarded(async (context: { request: Request; env: SpeechEnv }) => {
  const { request, env } = context
  if (!(await currentUser(request, env.DB))) {
    return json({ error: '请先登录' }, 401)
  }
  if (!env.AI) {
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

  const buffer = await file.arrayBuffer()
  const bytes = new Int8Array(buffer)
  const audio = Array.from(bytes)
  if (new URL(request.url).searchParams.has('probe')) {
    return json({
      size: file.size,
      bufferType: Object.prototype.toString.call(buffer),
      audioIsArray: Array.isArray(audio),
      audioType: typeof audio,
      length: audio.length,
      head: audio.slice(0, 3),
    })
  }
  let result: { text?: string }
  try {
    result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio })
  } catch (error) {
    return json({ error: 'asr failed', detail: String(error).slice(0, 300) }, 500)
  }
  const text = typeof result?.text === 'string' ? result.text.trim() : ''
  return json({ text })
})
