/**
 * 构建前把两份静态资源准备好，产物里必须有，但都不进仓库：
 *
 * 1. `static/ort/v1/*`：onnxruntime 的 wasm 与 glue，直接从 `onnxruntime-web` 包里拷。
 *    版本由 pnpm-lock 锁住，没必要把 32MB 二进制再存一份在 git 里。
 * 2. `static/models/v1/Xenova/bge-small-zh-v1.5/*`：24MB 模型，构建时下载。
 *    先试 huggingface.co，超时或失败再回退 hf-mirror.com（Cloudflare 构建机在国外，
 *    HF 通常更快；国内网络反过来）。
 *
 * 下载完一律校验 sha256：哈希固定在这里，对不上就失败并说清是哪个文件，
 * 绝不静默降级——模型坏了比构建失败难查得多。
 *
 * 本地开发：文件已存在且哈希正确就跳过，不联网。
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const staticDir = path.join(root, 'static')

/** 与 src/services/memory/localModel.ts 的 LOCAL_MODEL_VERSION 同步 */
const MODEL_VERSION = 'v1'
const ORT_VERSION = 'v1'
const REPO = 'Xenova/bge-small-zh-v1.5'
const MODEL_DIR = path.join(staticDir, 'models', MODEL_VERSION, REPO)
const ORT_DIR = path.join(staticDir, 'ort', ORT_VERSION)

/** 只允许从这两个地方取，顺序有意义：HF 优先，镜像兜底 */
const MODEL_HOSTS = ['https://huggingface.co', 'https://hf-mirror.com']

/**
 * 期望的哈希：删掉仓库里那份之前用 `sha256sum` 记下来的值。
 * 换模型 = 换 LOCAL_MODEL_VERSION + 换这张表。
 */
const MODEL_FILES = [
  { path: 'config.json', sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f' },
  { path: 'tokenizer_config.json', sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a' },
  { path: 'tokenizer.json', sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' },
  {
    path: 'onnx/model_quantized.onnx',
    sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
  },
]

/** ort 从包里拷这几个：两个后端各一对（wasm 本体 + loader glue） */
const ORT_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
]

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

const exists = async (file) => {
  try {
    const info = await stat(file)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

/** onnxruntime-web 是 transformers 的依赖，要用它的 require 才能解析到 pnpm 里的实体目录 */
const resolveOrtDist = () => {
  const require = createRequire(import.meta.url)
  // 包的 package.json 不在 exports 里，只能先解析入口文件，再从它的位置解析依赖
  const fromTransformers = createRequire(require.resolve('@huggingface/transformers'))
  const ortEntry = fromTransformers.resolve('onnxruntime-web')
  // onnxruntime-web 的入口在 dist/ 下，取它的目录即可
  return path.dirname(ortEntry)
}

const copyOrt = async () => {
  const dist = resolveOrtDist()
  await mkdir(ORT_DIR, { recursive: true })
  for (const name of ORT_FILES) {
    const from = path.join(dist, name)
    const to = path.join(ORT_DIR, name)
    if (!(await exists(from))) {
      throw new Error(`[assets] onnxruntime 包里找不到 ${name}（${dist}）`)
    }
    await cp(from, to)
  }
  console.log(`[assets] ort: ${ORT_FILES.length} 个文件已从 node_modules 拷到 static/ort/${ORT_VERSION}`)
}

const fetchModel = async (file) => {
  const target = path.join(MODEL_DIR, file.path)
  if (await exists(target)) {
    const digest = sha256(await readFile(target))
    if (digest === file.sha256) {
      console.log(`[assets] 跳过（已存在且哈希正确）：${file.path}`)
      return
    }
    console.warn(`[assets] 本地文件哈希不对，重新下载：${file.path}`)
    await rm(target, { force: true })
  }

  await mkdir(path.dirname(target), { recursive: true })
  const errors = []
  for (const host of MODEL_HOSTS) {
    const url = `${host}/${REPO}/resolve/main/${file.path}`
    const timeout = file.path.endsWith('.onnx') ? 240_000 : 30_000
    try {
      const started = Date.now()
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      const digest = sha256(buffer)
      if (digest !== file.sha256) {
        // 拿到的东西不对就丢掉，换下一个源重试；两个都错就直接失败
        errors.push(`${host} 哈希不符：期望 ${file.sha256}，实际 ${digest}`)
        continue
      }
      await writeFile(target, buffer)
      console.log(
        `[assets] 下载 ${file.path} 来自 ${new URL(host).hostname}（${(buffer.length / 1048576).toFixed(1)}MB，${Date.now() - started}ms）`
      )
      return
    } catch (error) {
      errors.push(`${host} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`[assets] 模型文件 ${file.path} 下载失败，构建终止：\n  ${errors.join('\n  ')}`)
}

const main = async () => {
  if (process.env.SKIP_ASSET_PREPARE === '1') {
    console.log('[assets] SKIP_ASSET_PREPARE=1，跳过准备')
    return
  }
  await copyOrt()
  for (const file of MODEL_FILES) {
    await fetchModel(file)
  }
  console.log('[assets] 静态资源准备完成')
}

await main()
