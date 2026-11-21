import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__API_ORIGIN__ = ''
})

const model = await import('../src/services/memory/localModel')
const store = await import('../src/services/memory/store')
const api = await import('../src/services/memory/api')

/**
 * 本地模型的三个前提，任何一个变了都要有人知道：
 * 文件清单（决定下载量）、版本（决定缓存失效）、阈值（决定召回多少）。
 */
describe('本地向量模型', () => {
  it('模型文件清单加起来就是总字节数，且包含 onnx 本体', () => {
    const sum = model.MODEL_FILES.reduce((total, file) => total + file.bytes, 0)
    expect(sum).toBe(model.MODEL_TOTAL_BYTES)
    expect(model.MODEL_FILES.some((file) => file.path === 'onnx/model_quantized.onnx')).toBe(true)
    // 24MB 上下：数量级写死在这里，防止有人误把一个 90MB 的 fp32 塞进来
    expect(model.MODEL_TOTAL_BYTES).toBeGreaterThan(20e6)
    expect(model.MODEL_TOTAL_BYTES).toBeLessThan(30e6)
  })

  it('下载地址锁在固定 commit 上，缓存名带 commit 与权重哈希', () => {
    // commit 写死在代码里：用 main 的话上游一更新，向量空间就漂了
    expect(model.MODEL_COMMIT).toMatch(/^[0-9a-f]{40}$/)
    expect(model.modelFileUrl('config.json')).toBe(
      `${model.MODEL_MIRROR}/${model.LOCAL_MODEL_ID}/resolve/${model.MODEL_COMMIT}/config.json`
    )
    // transformers.js 的 remoteURL 必须与下载器的键同一形状，否则缓存永远命不中
    expect(model.MODEL_REMOTE_PATH_TEMPLATE).toContain(model.MODEL_COMMIT)
    expect(model.modelCacheName()).toContain(model.MODEL_COMMIT.slice(0, 8))
    expect(model.ortBaseUrl()).toContain(`/${model.ORT_VERSION}/`)
  })

  it('下载量里包含推理运行时：4 个 ort 文件、带 asyncify，且目录是 v2', () => {
    expect(model.ORT_VERSION).toBe('v2')
    const sum = model.ORT_RUNTIME_FILES.reduce((total, file) => total + file.bytes, 0)
    expect(sum).toBe(model.ORT_TOTAL_BYTES)
    // WebGPU 走 asyncify，WASM 兜底走 plain：两份少一份就有设备起不来
    expect(model.ORT_RUNTIME_FILES.some((file) => file.path.includes('asyncify.wasm'))).toBe(true)
    // wasm 发的是 gzip 过的：单文件必须留在 Pages 的 25MiB 限制以内
    for (const file of model.ORT_RUNTIME_FILES) {
      expect(file.bytes).toBeLessThan(25 * 1024 * 1024)
    }
    expect(model.ORT_TOTAL_BYTES).toBeGreaterThan(6e6)
    expect(model.ORT_TOTAL_BYTES).toBeLessThan(8e6)
  })

  it('每个文件的 sha256 都是 64 位十六进制，且与字节数量级相称', () => {
    for (const file of model.MODEL_FILES) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.bytes).toBeGreaterThan(0)
    }
    const onnx = model.MODEL_FILES.find((file) => file.path.endsWith('.onnx'))
    expect(onnx?.sha256).toBe('15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc')
    expect(onnx?.bytes).toBe(24010842)
  })

  it('阈值按三套向量空间分开：本地 0.46，不当成 bge-m3 的 0.55', () => {
    expect(store.MEMORY_THRESHOLD_LOCAL).toBe(0.46)
    expect(store.memoryThreshold(model.LOCAL_MODEL_LABEL)).toBe(0.46)
    expect(store.memoryThreshold('cf-bge-m3')).toBe(store.MEMORY_THRESHOLD_BGE)
    expect(store.memoryThreshold('xop3qwen8bembedding')).toBe(store.MEMORY_THRESHOLD_QWEN)
  })

  it('远端链路默认关闭，但代码仍在', () => {
    expect(api.REMOTE_EMBEDDINGS_ENABLED).toBe(false)
    expect(typeof api.embedTextsRemote).toBe('function')
  })
})
