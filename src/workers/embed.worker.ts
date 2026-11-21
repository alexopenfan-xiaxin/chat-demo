/**
 * 向量推理 Worker。
 *
 * 为什么放 Worker：模型加载与推理是几十到几百毫秒的同步计算，放主线程会让出字和滚动卡一下。
 *
 * 为什么优先 WebGPU：手机上的 WASM 单线程是瓶颈（桌面实测单条 14ms，4× 降速后 70ms），
 * WebGPU 能把这部分挪到 GPU。没有 WebGPU（iOS 16 的 Safari、旧版 Chrome）就退回 WASM，
 * 两条路的模型文件是同一份 q8。
 *
 * 模型与 wasm 全部同源自托管（见 localModel.ts），不碰 HuggingFace。
 */
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'
import {
  LOCAL_MODEL_ID,
  LOCAL_MODEL_POOLING,
  modelBaseUrl,
  modelCacheName,
  ortBaseUrl,
} from '../services/memory/localModel.js'

export type EmbedRequest = { type: 'init' } | { type: 'embed'; id: number; texts: string[] }

export type EmbedResponse =
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'vectors'; id: number; dim: number; vectors: number[][] }
  | { type: 'error'; id: number; reason: string }

env.allowLocalModels = true
env.allowRemoteModels = false
// 绝对地址：transformers.js 拿它当缓存键，相对路径在 worker 里构造 Request 会失败
env.localModelPath = modelBaseUrl()
env.useBrowserCache = false
env.useCustomCache = true
env.customCache = {
  match: async (key: string) => {
    const cache = await caches.open(modelCacheName())
    return (await cache.match(key)) ?? undefined
  },
  put: async (key: string, value: Response) => {
    const cache = await caches.open(modelCacheName())
    await cache.put(key, value)
  },
} as unknown as typeof env.customCache
// wasm 也自托管：ORT 默认会去 CDN 拉，手机在弱网下同样不可靠
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = ortBaseUrl()
}

let pipe: FeatureExtractionPipeline | null = null
let device: 'webgpu' | 'wasm' = 'wasm'
let loading: Promise<void> | null = null

const webgpuAvailable = async (): Promise<boolean> => {
  try {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu
    if (!gpu) {
      return false
    }
    return (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

const options = (target: 'webgpu' | 'wasm') => ({
  device: target,
  dtype: 'q8' as const,
  pooling: LOCAL_MODEL_POOLING,
  normalize: true,
})

/** 先 WebGPU 再 WASM：WebGPU 建图失败时换 WASM 重来，不把错误甩给上层 */
const build = async (): Promise<void> => {
  const targets: ('webgpu' | 'wasm')[] = (await webgpuAvailable()) ? ['webgpu', 'wasm'] : ['wasm']
  let lastError: unknown = null
  for (const target of targets) {
    try {
      pipe = (await pipeline(
        'feature-extraction',
        LOCAL_MODEL_ID,
        options(target)
      )) as unknown as FeatureExtractionPipeline
      device = target
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('model_load_failed')
}

const ensurePipe = async (): Promise<void> => {
  if (pipe) {
    return
  }
  loading ??= build().finally(() => {
    loading = null
  })
  await loading
}

self.onmessage = async (event: MessageEvent<EmbedRequest>) => {
  const message = event.data
  if (message.type === 'init') {
    try {
      await ensurePipe()
      ;(self as unknown as Worker).postMessage({ type: 'ready', device } satisfies EmbedResponse)
    } catch (error) {
      ;(self as unknown as Worker).postMessage({
        type: 'error',
        id: -1,
        reason: error instanceof Error ? error.message : 'model_load_failed',
      } satisfies EmbedResponse)
    }
    return
  }
  if (message.type !== 'embed') {
    return
  }
  try {
    await ensurePipe()
    if (!pipe) {
      throw new Error('model_not_loaded')
    }
    const output = (await pipe(message.texts, {
      pooling: LOCAL_MODEL_POOLING,
      normalize: true,
    })) as { data: Float32Array; dims: number[] }
    const dim = output.dims.at(-1) ?? 0
    const vectors: number[][] = []
    for (let index = 0; index < message.texts.length; index++) {
      vectors.push(Array.from(output.data.slice(index * dim, (index + 1) * dim)))
    }
    ;(self as unknown as Worker).postMessage({
      type: 'vectors',
      id: message.id,
      dim,
      vectors,
    } satisfies EmbedResponse)
  } catch (error) {
    // 推理失败时把 pipe 丢掉：下一次重新建图，别让一次坏状态卡住整条链
    pipe = null
    ;(self as unknown as Worker).postMessage({
      type: 'error',
      id: message.id,
      reason: error instanceof Error ? error.message : 'embed_failed',
    } satisfies EmbedResponse)
  }
}
