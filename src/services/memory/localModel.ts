/**
 * 本地向量模型：文件清单、运行时下载、缓存。
 *
 * 我们这边**不存放也不分发模型**：用户浏览器直接从 hf-mirror 拉（境外更快时回退 huggingface.co），
 * 我们自己的产物里只有 onnxruntime 的 wasm（运行时引擎，不是模型）。
 *
 * 三条硬约束：
 * 1. commit 固定，不用 `main`——上游一更新权重，向量空间就变了，旧条目全部作废。
 * 2. 每个文件下载完用 Web Crypto 校验 sha256，对不上就不入缓存，按失败处理。
 * 3. 缓存键就是下载 URL（含 commit），命中即跳过；模型不会过期，清站点数据才会重下。
 */

/** HuggingFace 仓库名：transformers.js 会把它拼进路径 */
export const LOCAL_MODEL_ID = 'Xenova/bge-small-zh-v1.5'

/**
 * 固定的 commit。换模型 = 换这一行 + 换下面的哈希表 + 换 LOCAL_MODEL_LABEL。
 * 2026-11-21 核对：该 commit 下四个文件的 sha256 与我们先前实测过的那份完全一致。
 */
export const MODEL_COMMIT = '75c43b069aac4d136ba6bc1122f995fedcfd2781'

/** 首选镜像（国内快），失败回退官方源 */
export const MODEL_MIRROR = 'https://hf-mirror.com'
export const MODEL_UPSTREAM = 'https://huggingface.co'

/** 存进条目 `model` 字段的标识：它是「哪一套向量空间」的标记 */
export const LOCAL_MODEL_LABEL = 'local-bge-small-zh-v1.5'

/** bge-small-zh-v1.5 输出 512 维 */
export const LOCAL_MODEL_DIM = 512

/** 池化方式：BGE 系列按 CLS 训练，用均值池化会偏 */
export const LOCAL_MODEL_POOLING = 'cls' as const

/** onnxruntime 的 wasm 仍由我们自己的产物提供，版本跟着构建走 */
export const ORT_VERSION = 'v1'

export type ModelFile = { path: string; bytes: number; sha256: string }

/**
 * 需要下载的四个文件：`bytes` 只用于算进度，`sha256` 是入缓存的闸门。
 * 哈希来自本地实测并通过构建产物部署核对过的那一份。
 */
export const MODEL_FILES: ModelFile[] = [
  {
    path: 'config.json',
    bytes: 716,
    sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
  },
  {
    path: 'tokenizer_config.json',
    bytes: 367,
    sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
  },
  {
    path: 'tokenizer.json',
    bytes: 439125,
    sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
  },
  {
    path: 'onnx/model_quantized.onnx',
    bytes: 24010842,
    sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
  },
]

export const MODEL_TOTAL_BYTES = MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0)

const ONNX = MODEL_FILES.find((file) => file.path.endsWith('.onnx'))

/**
 * 缓存名带 commit 与权重哈希：换模型时老缓存自然失效，下面还会顺手清掉。
 * 名字里不放密码学级别的信息，只取前 8 位便于排查。
 */
export const modelCacheName = () =>
  `ds-chat-embed-${MODEL_COMMIT.slice(0, 8)}-${(ONNX?.sha256 ?? '').slice(0, 8)}`

const CACHE_PREFIX = 'ds-chat-embed-'

const origin = () => (typeof self === 'undefined' ? '' : self.location.origin)

/** 模型根地址：`<host>/<repo>/resolve/<commit>/`，transformers.js 与下载器用同一个 */
export const modelRootUrl = (host: string) => `${host}/${LOCAL_MODEL_ID}/resolve/${MODEL_COMMIT}/`

/**
 * 下载与缓存的键固定用镜像地址。这样即使某次字节是从 huggingface.co 取的，
 * 也仍以镜像地址入缓存——transformers.js 查的就是这个键。
 */
export const modelFileUrl = (path: string) => modelRootUrl(MODEL_MIRROR) + path

/** transformers.js 的 remoteHost / remotePathTemplate，与上面的键一一对应 */
export const MODEL_REMOTE_PATH_TEMPLATE = `{model}/resolve/${MODEL_COMMIT}/`

export const ortBaseUrl = () => `${origin()}/ort/${ORT_VERSION}/`

/** 下载进度回调：已下字节 / 总字节 / 当前文件 */
export type DownloadProgress = (done: number, total: number, file: string) => void

const openCache = () => caches.open(modelCacheName())

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')

const sha256 = async (data: ArrayBuffer) => hex(await crypto.subtle.digest('SHA-256', data))

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
 * 每个文件先打镜像、再打官方源；sha256 对不上就丢掉换下一个源，两个都不对算失败。
 * 失败时抛错，界面据此显示「下载失败，请检查网络后重试」——不静默、也不让记忆半开着。
 */
export const downloadLocalModel = async (onProgress?: DownloadProgress): Promise<void> => {
  const cache = await openCache()
  const total = MODEL_TOTAL_BYTES
  let done = 0

  for (const file of MODEL_FILES) {
    const key = modelFileUrl(file.path)
    if (await cache.match(key)) {
      done += file.bytes
      onProgress?.(Math.min(done, total), total, file.path)
      continue
    }

    const errors: string[] = []
    let stored = false
    for (const host of [MODEL_MIRROR, MODEL_UPSTREAM]) {
      const url = modelRootUrl(host) + file.path
      try {
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const buffer = await response.arrayBuffer()
        const digest = await sha256(buffer)
        if (digest !== file.sha256) {
          errors.push(`${new URL(host).hostname} 哈希不符：期望 ${file.sha256}，实际 ${digest}`)
          continue
        }
        // 缓存键固定用镜像地址：transformers.js 查的就是它
        await cache.put(
          key,
          new Response(buffer, {
            headers: { 'content-type': file.path.endsWith('.json') ? 'application/json' : 'application/octet-stream' },
          })
        )
        done += buffer.byteLength
        onProgress?.(Math.min(done, total), total, file.path)
        stored = true
        break
      } catch (error) {
        errors.push(`${new URL(host).hostname} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!stored) {
      throw new Error(`model_download_failed ${file.path}: ${errors.join(' | ')}`)
    }
  }
  onProgress?.(total, total, '')
  await dropStaleCaches()
}

/** 清掉旧版本、旧来源留下的缓存（含早期「模型随产物分发」那一版） */
const dropStaleCaches = async () => {
  try {
    const current = modelCacheName()
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== current) {
        await caches.delete(name)
      }
    }
  } catch {
    // 清不掉不影响当前会话
  }
}

/** 清掉当前缓存（用户在设置里「清除本地模型」时用） */
export const deleteLocalModel = async (): Promise<void> => {
  try {
    await caches.delete(modelCacheName())
  } catch {
    // 删不掉不影响当前会话，下次下载会覆盖写
  }
}
