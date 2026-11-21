import { create } from 'zustand'
import { LOCAL_MODEL_DIM, LOCAL_MODEL_LABEL, hasLocalModel } from './localModel.js'
import type { EmbedResponse } from '../../workers/embed.worker.js'

/**
 * 主线程这一侧：一个 Worker 单例、一条消息通道。
 *
 * 状态单独放一个 store，界面据此显示「正在准备本地模型」之类的提示；
 * 注意它和「下载」是两件事：下载完不等于已经建好图（首次建图要解析 24MB onnx）。
 */
export type LocalModelState = 'idle' | 'loading' | 'ready' | 'failed'

export const useLocalModel = create<{
  status: LocalModelState
  device: 'webgpu' | 'wasm' | null
  error: string | null
}>(() => ({ status: 'idle', device: null, error: null }))

type Pending = {
  resolve: (value: { vectors: number[][]; dim: number }) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, Pending>()
let warm: Promise<void> | null = null

const ensureWorker = () => {
  if (worker) {
    return worker
  }
  // 经典 worker，不是 module worker：onnxruntime 用 importScripts 加载 wasm glue，
  // module worker 里这个 API 一调就抛「Module scripts don't support importScripts()」。
  worker = new Worker(new URL('../../workers/embed.worker.ts', import.meta.url))
  worker.onmessage = (event: MessageEvent<EmbedResponse>) => {
    const message = event.data
    if (message.type === 'ready') {
      useLocalModel.setState({ status: 'ready', device: message.device, error: null })
      return
    }
    if (message.type === 'error' && message.id === -1) {
      useLocalModel.setState({ status: 'failed', error: message.reason })
      const waiting = [...pending.values()]
      pending.clear()
      for (const entry of waiting) {
        clearTimeout(entry.timer)
        entry.reject(new Error(message.reason))
      }
      return
    }
    if (message.type === 'error') {
      const entry = pending.get(message.id)
      if (entry) {
        pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.reject(new Error(message.reason))
      }
      return
    }
    if (message.type === 'vectors') {
      const entry = pending.get(message.id)
      if (entry) {
        pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve({ vectors: message.vectors, dim: message.dim })
      }
    }
  }
  worker.onerror = (event) => {
    useLocalModel.setState({ status: 'failed', error: event.message || 'worker_error' })
  }
  return worker
}

/**
 * 预热：把 Worker 建起来并把图建好。
 *
 * 已下载过模型时在进页面后调一次，避免用户第一次发消息时才付建图的几百毫秒。
 * 没下载过就直接返回——不在这里替用户决定要不要下 24MB。
 */
export const warmLocalModel = async (): Promise<void> => {
  if (warm) {
    return warm
  }
  if (!(await hasLocalModel())) {
    return
  }
  useLocalModel.setState({ status: 'loading' })
  warm = new Promise<void>((resolve) => {
    const instance = ensureWorker()
    const finish = () => {
      clearTimeout(timer)
      resolve()
    }
    // 建图最坏要几秒（手机上更久），给 20 秒；超时就当失败，下次调用重来
    const timer = setTimeout(() => {
      useLocalModel.setState({ status: 'failed', error: 'load_timeout' })
      resolve()
    }, 20000)
    const onMessage = (event: MessageEvent<EmbedResponse>) => {
      if (event.data.type === 'ready') {
        // 建图之后立刻跑一次推理：第一次推理比之后每次都慢一个量级
        // （实测冷启 725–802ms、热态 13–20ms），不预热就会把页面加载后的第一条消息
        // 顶掉 800ms 的召回预算，用户看到「参考了 0 条」。
        instance.postMessage({ type: 'embed', id: -2, texts: ['预热'] })
        return
      }
      if (event.data.type === 'vectors' && event.data.id === -2) {
        instance.removeEventListener('message', onMessage)
        finish()
        return
      }
      if (event.data.type === 'error' && event.data.id === -1) {
        instance.removeEventListener('message', onMessage)
        finish()
      }
    }
    instance.addEventListener('message', onMessage)
    instance.postMessage({ type: 'init' })
  })
  return warm
}

/** 关掉 Worker 并清空在途请求（换账号、退出登录、删除模型后调用） */
export const resetLocalModel = () => {
  worker?.terminate()
  worker = null
  warm = null
  for (const entry of pending.values()) {
    clearTimeout(entry.timer)
    entry.reject(new Error('worker_reset'))
  }
  pending.clear()
  useLocalModel.setState({ status: 'idle', device: null, error: null })
}

/**
 * 算向量。超时按调用方给的预算走（召回 800ms、写入 6s），超时就 reject，
 * 由 api.ts 决定是降级还是当作写入失败——这里不做任何兜底，避免两处各有一套策略。
 */
export const embedLocal = (
  texts: string[],
  timeoutMs: number
): Promise<{ vectors: number[][]; dim: number }> => {
  const instance = ensureWorker()
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('embed_timeout'))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    instance.postMessage({ type: 'embed', id, texts })
  })
}

export type { EmbedResponse }
export { LOCAL_MODEL_DIM, LOCAL_MODEL_LABEL }
