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

/**
 * 存进条目 `model` 字段的标识：它是「哪一套向量空间」的标记。
 *
 * `-wasm` 后缀不只是说明后端：WebGPU 那条路算出来的向量是坏的（无关句两两
 * 0.48–0.57），换回 WASM 就等于换了向量空间，老条目必须按新标签重算——
 * reindex 只挑 `model !== 当前标签` 的条目，标签不变它们永远不会被修。
 */
export const LOCAL_MODEL_LABEL = 'local-bge-small-zh-v1.5-wasm'

/** bge-small-zh-v1.5 输出 512 维 */
export const LOCAL_MODEL_DIM = 512

/** 池化方式：BGE 系列按 CLS 训练，用均值池化会偏 */
export const LOCAL_MODEL_POOLING = 'cls' as const

/** onnxruntime 的 wasm 仍由我们自己的产物提供，版本跟着构建走 */
export const ORT_VERSION = 'v2'

export type ModelFile = { path: string; bytes: number; sha256: string }

/**
 * 推理运行时（onnxruntime 的 wasm 与 glue）：跟着产物走、不随模型。
 *
 * transform 4.x / ort 1.31 起 WebGPU 走 `asyncify` 变体，WASM 兜底走 plain 那一份，
 * 两份都必须有。体积是实测值，同样要算进下载进度——用户看到的一次下载是模型 + 运行时。
 */
export type RuntimeFile = { path: string; bytes: number }

export const ORT_RUNTIME_FILES: RuntimeFile[] = [
  // ort 1.31 只用 asyncify 这份 glue，且 wasm 本体 25.6MiB 超过 Pages 单文件上限，
  // 所以发 gzip、浏览器侧解压后交给 ORT 的 wasmBinary
  { path: 'ort-wasm-simd-threaded.asyncify.mjs', bytes: 52406 },
  { path: 'ort-wasm-simd-threaded.asyncify.wasm.gz', bytes: 6625019 },
]

export const ORT_TOTAL_BYTES = ORT_RUNTIME_FILES.reduce((sum, file) => sum + file.bytes, 0)

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

/** 每个源最多试几次：镜像对连续请求会 429，退避重试比直接失败好 */
const DOWNLOAD_ATTEMPTS = 3

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

/**
 * 下载进度回调：已下字节 / 总字节 / 当前文件。
 *
 * `total` 为 0 表示这次拿不到总量（比如响应没有 content-length），界面此时只显示百分比，
 * 不显示 `0 / 0 MB` 这种假数字。
 */
export type DownloadProgress = (done: number, total: number, file: string) => void

const openCache = () => caches.open(modelCacheName())

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')

const sha256 = async (data: ArrayBuffer) => hex(await crypto.subtle.digest('SHA-256', data))

/** 运行时是否已经落盘：用一个标记文件记，省得为了查一遍去请求 40MB */
const ortMarkerKey = () => `${ortBaseUrl()}.ready`

/** 分子要按字节算，不能按文件数：2 个运行时文件占了总量的六成，按个数会在中途跳一大格 */
const runtimeTimeout = (path: string) => (path.endsWith('.wasm') ? 240_000 : 30_000)

/**
 * 按块读响应，边读边报字节。
 *
 * 不用 `arrayBuffer()` 的理由：25MB 的权重与 26MB 的 wasm 一次性读完，进度条会从 0
 * 直接跳到该文件的占比，看着像卡住；按块读能把「当前文件已收字节」算进分子。
 */
const readStream = async (
  response: Response,
  onBytes: (bytes: number) => void
): Promise<ArrayBuffer> => {
  if (!response.body) {
    const buffer = await response.arrayBuffer()
    onBytes(buffer.byteLength)
    return buffer
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let seen = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    chunks.push(value)
    seen += value.byteLength
    onBytes(value.byteLength)
  }
  const merged = new Uint8Array(seen)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged.buffer as ArrayBuffer
}

/** 模型四个文件 + 运行时都已在缓存里；任何一次异常都按「没有」处理，宁可重下一遍 */
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
    return Boolean(await cache.match(ortMarkerKey()))
  } catch {
    return false
  }
}

/**
 * 下载缺失的模型与推理运行时，模型部分写进 Cache Storage。
 *
 * 模型每个文件先打镜像、再打官方源；sha256 对不上就丢掉换下一个源，两个都不对算失败。
 * 运行时是同源静态资源，失败直接算下载失败——不静默、也不让记忆半开着。
 *
 * 进度只有一个总量（模型 + 运行时），按字节加权；任何一个文件读不到 content-length
 * 时总量仍按上表算，界面显示的是真实已下字节，不会出现 0 / 0。
 */
export const downloadLocalModel = async (onProgress?: DownloadProgress): Promise<void> => {
  const cache = await openCache()
  const total = MODEL_TOTAL_BYTES + ORT_TOTAL_BYTES
  let done = 0
  const report = (extra: number, file: string) =>
    onProgress?.(Math.min(done + extra, total), total, file)

  for (const file of MODEL_FILES) {
    const key = modelFileUrl(file.path)
    if (await cache.match(key)) {
      done += file.bytes
      report(0, file.path)
      continue
    }

    const errors: string[] = []
    let stored = false
    for (const host of [MODEL_MIRROR, MODEL_UPSTREAM]) {
      for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS && !stored; attempt++) {
        const url = modelRootUrl(host) + file.path
        let received = 0
        try {
          const response = await fetch(url, {
            // 小文件 30 秒、权重 4 分钟；没有超时的话，一次卡住就是一条不动的进度条
            signal: AbortSignal.timeout(runtimeTimeout(file.path)),
          })
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`)
          }
          const buffer = await readStream(response, (bytes) => {
            received += bytes
            report(received, file.path)
          })
          const digest = await sha256(buffer)
          if (digest !== file.sha256) {
            errors.push(`${new URL(host).hostname} 哈希不符：期望 ${file.sha256}，实际 ${digest}`)
            received = 0
            report(received, file.path)
            break
          }
          // 缓存键固定用镜像地址：transformers.js 查的就是它
          await cache.put(
            key,
            new Response(buffer, {
              headers: {
                'content-type': file.path.endsWith('.json')
                  ? 'application/json'
                  : 'application/octet-stream',
              },
            })
          )
          done += buffer.byteLength
          report(0, file.path)
          stored = true
        } catch (error) {
          errors.push(
            `${new URL(host).hostname} 第 ${attempt + 1} 次失败：${error instanceof Error ? error.message : String(error)}`
          )
          // 连续几个文件会撞上镜像的限流（429 在浏览器里表现为 CORS 错误），退避一下再来
          received = 0
          report(received, file.path)
          if (attempt < DOWNLOAD_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)))
          }
        }
      }
      if (stored) {
        break
      }
    }
    if (!stored) {
      throw new Error(`model_download_failed ${file.path}: ${errors.join(' | ')}`)
    }
  }

  // 运行时：同源静态资源，进的是 HTTP 缓存（/ort/* 是 immutable），这里只负责把字节拉回来
  if (await cache.match(ortMarkerKey())) {
    done += ORT_TOTAL_BYTES
    report(0, '')
  } else {
    for (const file of ORT_RUNTIME_FILES) {
      const url = ortBaseUrl() + file.path
      const response = await fetch(url, { signal: AbortSignal.timeout(runtimeTimeout(file.path)) })
      if (!response.ok) {
        throw new Error(`runtime_download_failed ${file.path}: HTTP ${response.status}`)
      }
      let received = 0
      await readStream(response, (bytes) => {
        received += bytes
        report(received, file.path)
      })
      done += received
      report(0, file.path)
    }
    await cache.put(ortMarkerKey(), new Response('ok'))
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
