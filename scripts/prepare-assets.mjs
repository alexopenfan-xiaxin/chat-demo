/**
 * 构建前准备 onnxruntime 的运行时文件。
 *
 * `static/ort/v1/*`：wasm 与 glue，直接从 `onnxruntime-web` 包里拷，版本由 pnpm-lock 锁住。
 * 这是运行时引擎、不是模型，所以随产物分发；**模型本身不进产物也不进仓库**，
 * 由用户在浏览器里从 hf-mirror 直接下载（见 src/services/memory/localModel.ts）。
 */
import { cp, mkdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const staticDir = path.join(root, 'static')

const ORT_VERSION = 'v1'
const ORT_DIR = path.join(staticDir, 'ort', ORT_VERSION)

/**
 * ort 的 wasm 仍随产物分发：那是运行时引擎，不是模型；模型由用户在浏览器里
 * 从镜像直接下载（见 src/services/memory/localModel.ts），产物里一个字节都没有。
 */
const ORT_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
]

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

const main = async () => {
  if (process.env.SKIP_ASSET_PREPARE === '1') {
    console.log('[assets] SKIP_ASSET_PREPARE=1，跳过准备')
    return
  }
  await copyOrt()
  console.log('[assets] 静态资源准备完成（只有 ort，模型由浏览器运行时下载）')
}

await main()
