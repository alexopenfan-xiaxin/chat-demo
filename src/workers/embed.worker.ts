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
  MODEL_MIRROR,
  MODEL_REMOTE_PATH_TEMPLATE,
  modelCacheName,
  ortBaseUrl,
} from '../services/memory/localModel.js'

export type EmbedRequest = { type: 'init' } | { type: 'embed'; id: number; texts: string[] }

export type EmbedResponse =
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'vectors'; id: number; dim: number; vectors: number[][] }
  | { type: 'error'; id: number; reason: string }

// 模型不随产物分发：远端就是镜像，命中缓存时不发任何请求。
// 缓存键 = remoteURL = `<镜像>/<仓库>/resolve/<固定 commit>/<文件>`，与下载器写进去的键一致。
env.allowLocalModels = false
env.allowRemoteModels = true
env.remoteHost = MODEL_MIRROR
env.remotePathTemplate = MODEL_REMOTE_PATH_TEMPLATE
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
  // 单线程：Pages 不发 COOP/COEP，多线程 WASM 本来就起不来
  env.backends.onnx.wasm.numThreads = 1
}

let pipe: FeatureExtractionPipeline | null = null
let device: 'webgpu' | 'wasm' = 'wasm'
let loading: Promise<void> | null = null

/**
 * WebGPU 后端**停用**：q8 权重在 WebGPU 执行器上算出来的向量是坏的。
 *
 * 实测（同一份 q8、同一份 wasm glue、同一个 Chromium，只换 device）：同一句话
 * WASM 与 WebGPU 的余弦只有 0.33–0.45；五句毫不相关的短句在 WebGPU 下两两
 * 0.48–0.57（WASM 是 0.20–0.38）。库里的老条目与本地 WebGPU 单条输出吻合到 0.998，
 * 召回分数于是变成 0.65/0.60，阈值 0.46 拦不住，无关记忆全被召回。
 *
 * 换成 true 之前必须重跑那组对照，确认无关两两回到 0.3 以下——否则等于把
 * 「召回分数不可信」重新打开一次。`LOCAL_MODEL_LABEL` 的 -wasm 后缀是同一件事的
 * 另一半：后端换了向量空间就换了，老条目必须按新标签重算。
 */
const WEBGPU_ENABLED = false

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

/** 默认只用 WASM；WebGPU 建图失败时同样是 WASM 兜底，不把错误甩给上层 */
const build = async (): Promise<void> => {
  const targets: ('webgpu' | 'wasm')[] =
    WEBGPU_ENABLED && (await webgpuAvailable()) ? ['webgpu', 'wasm'] : ['wasm']
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
