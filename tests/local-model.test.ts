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

  it('缓存名与路径都带版本号：换版本才会重新下载', () => {
    expect(model.modelCacheName()).toContain(model.LOCAL_MODEL_VERSION)
    expect(model.modelBaseUrl()).toContain(`/${model.LOCAL_MODEL_VERSION}/`)
    expect(model.modelBaseUrl()).toContain(model.LOCAL_MODEL_ID)
    expect(model.ortBaseUrl()).toContain(`/${model.ORT_VERSION}/`)
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
