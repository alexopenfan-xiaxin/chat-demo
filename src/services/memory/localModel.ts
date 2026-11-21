/**
 * 本地向量模型：文件清单、下载、缓存。
 *
 * 为什么要自托管：手机访问 HuggingFace 基本拿不下来，下载失败就等于记忆功能不可用。
 * 所以模型和 onnxruntime 的 wasm 都跟站点一起发布，同源取，不带 CORS、不带外网依赖。
 *
 * 版本：路径里带 `v1`，Cache Storage 的名字也带版本。换模型时把 LOCAL_MODEL_VERSION 加一，
 * 老缓存随之失效并清掉——`/models/*` 是 immutable 长缓存，不换路径的话换了文件也拿不到新的。
 */

/** HuggingFace 仓库名：路径要按 `org/name` 拼，transformers.js 靠它算本地路径 */
export const LOCAL_MODEL_ID = 'Xenova/bge-small-zh-v1.5'

/** 模型版本：换文件必须加一，否则浏览器与边缘都会一直用旧的 immutable 缓存 */
export const LOCAL_MODEL_VERSION = 'v1'

/**
 * 存进条目 `model` 字段的标识。不用仓库名，是因为这个值是「哪一套向量空间」的标记，
 * 换 provider 而不换模型时它不该变，换模型时必须变。
 */
export const LOCAL_MODEL_LABEL = 'local-bge-small-zh-v1.5'

/** bge-small-zh-v1.5 输出 512 维 */
export const LOCAL_MODEL_DIM = 512

/** 池化方式：BGE 系列按 CLS 训练，用均值池化会偏 */
export const LOCAL_MODEL_POOLING = 'cls' as const

/** onnxruntime 的 wasm 也自托管，版本跟着模型走 */
export const ORT_VERSION = 'v1'

export type ModelFile = { path: string; bytes: number }

/**
 * 需要下载的文件（相对模型根目录）。
 *
 * `bytes` 只用于算下载进度：分块读取时按真实字节数累加，这个值只是总量；
 * 它不参与校验，也不作为「下载完成」的判据——判据是缓存里四个文件都在。
 */
export const MODEL_FILES: ModelFile[] = [
  { path: 'config.json', bytes: 716 },
  { path: 'tokenizer_config.json', bytes: 367 },
  { path: 'tokenizer.json', bytes: 439125 },
  { path: 'onnx/model_quantized.onnx', bytes: 24010842 },
]

export const MODEL_TOTAL_BYTES = MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0)

/**
 * 界面上写的是「约 25MB」，这是给人看的口径（24.45MB 按十进制进位到整五）；
 * 代码里只用 MODEL_TOTAL_BYTES 算进度，不再另造一个会被误当真值的展示常量。
 */

export const modelCacheName = () => `ds-chat-embed-${LOCAL_MODEL_VERSION}`

const origin = () => (typeof self === 'undefined' ? '' : self.location.origin)

/**
 * 模型仓库的**上级**目录：transformers.js 自己会把 `<repoId>/<file>` 拼在 localModelPath 后面，
 * 所以这里只能给到 `/models/<版本>/`。给到含 repoId 的那层会让路径里出现两遍仓库名。
 */
export const modelsRootUrl = () => `${origin()}/models/${LOCAL_MODEL_VERSION}/`

/** 单个模型的目录：下载与缓存键用它 */
export const modelBaseUrl = () => `${modelsRootUrl()}${LOCAL_MODEL_ID}/`

export const ortBaseUrl = () => `${origin()}/ort/${ORT_VERSION}/`

export const modelFileUrl = (path: string) => modelBaseUrl() + path

/** 下载进度回调：已下字节 / 总字节 / 当前文件 */
export type DownloadProgress = (done: number, total: number, file: string) => void

const openCache = () => caches.open(modelCacheName())

/** 是否四个文件都已经在缓存里；任何一次异常都按「没有」处理，宁可重下一遍 */
export const hasLocalModel = async (): Promise<boolean> => {
  if (typeof caches === 'undefined') {
    return false
  }
  try {
    const cache = await openCache()
    for (const file of MODEL_FILES) {
      if (!(await cache.match(modelFileUrl(file.path)))) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * 下载缺失的文件并写进 Cache Storage。
 *
 * 已经缓存的文件跳过，所以中断后重进页面只补剩下的那几个。
 * 失败时抛错，调用方据此显示「下载失败，重试」——不静默、也不半开着让记忆可用。
 */
export const downloadLocalModel = async (onProgress?: DownloadProgress): Promise<void> => {
  const cache = await openCache()
  const total = MODEL_TOTAL_BYTES
  let done = 0
  for (const file of MODEL_FILES) {
    const url = modelFileUrl(file.path)
    if (await cache.match(url)) {
      done += file.bytes
      onProgress?.(Math.min(done, total), total, file.path)
      continue
    }
    const response = await fetch(`${url}?v=${LOCAL_MODEL_VERSION}`, { cache: 'no-store' })
    if (!response.ok || !response.body) {
      throw new Error(`model_download_failed ${file.path} ${response.status}`)
    }
    const chunks: Uint8Array[] = []
    const reader = response.body.getReader()
    for (;;) {
      const { done: finished, value } = await reader.read()
      if (finished) {
        break
      }
      chunks.push(value)
      done += value.byteLength
      onProgress?.(Math.min(done, total), total, file.path)
    }
    // 缓存用不带查询串的地址：transformers.js 查的就是这个键
    await cache.put(url, new Response(new Blob(chunks as BlobPart[]), { headers: { 'content-type': contentType(file.path) } }))
    done += Math.max(0, file.bytes - chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  }
  onProgress?.(total, total, '')
}

const contentType = (path: string) => (path.endsWith('.json') ? 'application/json' : 'application/octet-stream')

/** 清掉缓存（换版本、或用户在设置里「清除本地模型」时用） */
export const deleteLocalModel = async (): Promise<void> => {
  try {
    await caches.delete(modelCacheName())
  } catch {
    // 删不掉不影响当前会话，下次下载会覆盖写
  }
}
