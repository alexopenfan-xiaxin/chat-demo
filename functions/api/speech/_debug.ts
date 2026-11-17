import { guarded, json, type Env } from '../../../server/auth-core'

type SpeechEnv = Env & { SPEECH_TTS_URL?: string; SPEECH_KEY?: string; AI?: unknown }

/** 临时诊断：只看绑定是否存在，不回显任何密钥 */
export const onRequestPost = guarded(async (context: { request: Request; env: SpeechEnv }) => {
  const env = context.env
  let upstreamStatus = 'skipped'
  let upstreamBody = ''
  if (env.SPEECH_TTS_URL && env.SPEECH_KEY) {
    try {
      const r = await fetch(`${env.SPEECH_TTS_URL}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ds-chat-speech': env.SPEECH_KEY },
        body: JSON.stringify({ input: '测试', voice: 'zh-CN-XiaoxiaoNeural', response_format: 'mp3' }),
      })
      upstreamStatus = String(r.status)
      upstreamBody = r.ok ? `bytes:${(await r.arrayBuffer()).byteLength}` : (await r.text()).slice(0, 120)
    } catch (error) {
      upstreamStatus = 'throw'
      upstreamBody = String(error).slice(0, 200)
    }
  }
  return json({
    hasUrl: Boolean(env.SPEECH_TTS_URL),
    hasKey: Boolean(env.SPEECH_KEY),
    hasAI: Boolean(env.AI),
    hasDB: Boolean(env.DB),
    upstreamStatus,
    upstreamBody,
  })
})
