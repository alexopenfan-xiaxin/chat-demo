import { ApiError } from './client.js'

/**
 * 语音接口：走本站同源壳，会话用 cookie，不再带上游 API Key。
 * - ASR：POST /api/speech/asr，multipart 上传 WAV / Ogg Opus，返回 { text }
 * - TTS：POST /api/speech/tts，返回 mp3 字节流
 * 两个端点都在 Pages Functions 里校验登录会话，匿名调用直接 401。
 */
const SPEECH_BASE_URL = '/api/speech'

/** 朗读音色：Edge TTS 的四个中文音色短名 */
export type TtsVoice = 'xiaoxiao' | 'yunxi' | 'xiaoyi' | 'yunyang'

/** 语音识别：audio 为 WAV（单声道 16-bit PCM）或 Ogg Opus，时长不超过 120 秒、大小不超过 8 MiB */
export const transcribe = async (audio: Blob, signal?: AbortSignal): Promise<string> => {
  const form = new FormData()
  form.append('file', audio, 'recording.wav')
  const response = await fetch(`${SPEECH_BASE_URL}/asr`, {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
    signal,
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new ApiError(response.status === 401 ? 'session' : 'http', raw, response.status)
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('protocol', raw)
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('text' in body) ||
    typeof body.text !== 'string'
  ) {
    throw new ApiError('protocol', raw)
  }
  return body.text
}

/** 语音合成：返回 mp3 字节；正文过滤（代码块、表格等）在调用方先做 */
export const synthesize = async (
  text: string,
  voice: TtsVoice,
  signal: AbortSignal
): Promise<ArrayBuffer> => {
  const response = await fetch(`${SPEECH_BASE_URL}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }),
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    const raw = await response.text()
    throw new ApiError(response.status === 401 ? 'session' : 'http', raw, response.status)
  }
  return response.arrayBuffer()
}
