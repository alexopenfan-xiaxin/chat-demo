import { currentUser, guarded, json, type Env } from '../../../server/auth-core'

/**
 * POST /api/speech/tts
 * 同源壳：把朗读请求转给 Cloudflare 上的 VoiceCafe Worker（微软 Edge TTS）。
 * 前端只认这个地址，Worker 自身只接受带共享密钥的调用。
 */
type SpeechEnv = Env & { SPEECH_TTS_URL?: string; SPEECH_KEY?: string }

/** 前端传音色短名，这里映射到 Edge TTS 的 shortName；旧值 stella / tide 一并兼容 */
const VOICES: Record<string, string> = {
  xiaoxiao: 'zh-CN-XiaoxiaoNeural',
  yunxi: 'zh-CN-YunxiNeural',
  xiaoyi: 'zh-CN-XiaoyiNeural',
  yunyang: 'zh-CN-YunyangNeural',
  stella: 'zh-CN-XiaoxiaoNeural',
  tide: 'zh-CN-YunxiNeural',
}

const MAX_TEXT = 5000

export const onRequestPost = guarded(async (context: { request: Request; env: SpeechEnv }) => {
  const { request, env } = context
  // 会话校验也在 guarded 里做：middleware 里抛异常会变成 Cloudflare 的裸 502
  if (!(await currentUser(request, env.DB))) {
    return json({ error: '请先登录' }, 401)
  }
  if (!env.SPEECH_TTS_URL || !env.SPEECH_KEY) {
    return json({ error: '语音服务没有配置' }, 503)
  }
  let body: { text?: unknown; voice?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: '请求格式不对' }, 400)
  }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) {
    return json({ error: '没有要朗读的内容' }, 400)
  }
  if (text.length > MAX_TEXT) {
    return json({ error: '这段内容太长了' }, 413)
  }
  const voiceKey = typeof body.voice === 'string' ? body.voice.toLowerCase() : 'xiaoxiao'
  const upstream = VOICES[voiceKey] ?? VOICES.xiaoxiao

  // 微软侧的 WebSocket 握手偶尔会失败，重试一次再放弃
  const callUpstream = () =>
    fetch(`${env.SPEECH_TTS_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ds-chat-speech': env.SPEECH_KEY as string,
      },
      body: JSON.stringify({ input: text, voice: upstream }),
    })

  let response = await callUpstream()
  let audio = response.ok ? await response.arrayBuffer() : new ArrayBuffer(0)
  if (audio.byteLength === 0) {
    response = await callUpstream()
    audio = response.ok ? await response.arrayBuffer() : new ArrayBuffer(0)
  }
  if (audio.byteLength === 0) {
    return json({ error: '语音合成失败了，稍后再试' }, 503)
  }
  return new Response(audio, {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'content-length': String(audio.byteLength),
      'cache-control': 'no-store',
    },
  })
})
