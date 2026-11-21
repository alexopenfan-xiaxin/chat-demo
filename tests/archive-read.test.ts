import { describe, expect, it } from 'vitest'
import {
  ArchiveError,
  ArchiveFormatError,
  listArchivePaths,
  openArchive,
  readArchive,
  readEntryBlob,
  readEntryBytes,
  readEntryText,
} from '../src/services/chat/history/zipReader'
import { writeArchive } from '../src/services/chat/history/zipWriter'

/**
 * 统计对「盘」的调用：slice 是分片读，arrayBuffer 是整包读。
 * 安卓上每次 slice 都要过一次主线程调度，所以这两个数字就是问题本身。
 */
const countingFile = (blob: Blob) => {
  const file = new File([blob], 'history.zip', { type: 'application/zip' })
  const counts = { slice: 0, arrayBuffer: 0 }
  const proxy = new Proxy(file, {
    get(target, prop) {
      if (prop === 'slice') {
        return (start?: number, end?: number) => {
          counts.slice += 1
          return target.slice(start, end)
        }
      }
      if (prop === 'arrayBuffer') {
        return () => {
          counts.arrayBuffer += 1
          return target.arrayBuffer()
        }
      }
      // File 的方法必须绑回真身，Proxy 上没有 Blob 内部槽
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as File
  return { file: proxy, counts }
}

const sampleArchive = () =>
  writeArchive([
    { name: 'manifest.json', blob: new Blob(['{"export_format_version":3}']) },
    ...Array.from({ length: 5 }, (_, index) => ({
      name: `chat_sessions/s${index}.json`,
      blob: new Blob([JSON.stringify({ id: `s${index}`, body: 'x'.repeat(2000) })]),
    })),
  ])

describe('openArchive（整包读一次内存源）', () => {
  it('整包只读一次：一次 arrayBuffer，之后不再切片', async () => {
    const { file, counts } = countingFile(await sampleArchive())
    const archive = await openArchive(file)
    expect(counts.arrayBuffer).toBe(1)
    // 4 字节签名也改在内存里看，不再为它单独读一次盘
    expect(counts.slice).toBe(0)
    expect(archive.entries).toHaveLength(6)
    expect(archive.entries.filter((entry) => entry.path.startsWith('chat_sessions/'))).toHaveLength(
      5
    )
    expect(archive.source.size).toBe(file.size)
  })

  it('条目再多也不碰文件：读完全部条目后切片次数仍是 0', async () => {
    const { file, counts } = countingFile(await sampleArchive())
    const archive = await openArchive(file)
    for await (const entry of readArchive(archive)) {
      await readEntryText(entry)
    }
    expect(counts.slice).toBe(0)
    expect(counts.arrayBuffer).toBe(1)
  })

  it('列目录是纯内存操作，不再碰文件', async () => {
    const { file, counts } = countingFile(await sampleArchive())
    const archive = await openArchive(file)
    const before = { ...counts }
    const paths = listArchivePaths(archive)
    expect(paths).toContain('manifest.json')
    expect(counts).toEqual(before)
  })

  it('整包读入单独计时：onLoad 拿到毫秒数', async () => {
    const { file } = countingFile(await sampleArchive())
    const seen: number[] = []
    await openArchive(file, undefined, (ms) => seen.push(ms))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeGreaterThanOrEqual(0)
  })

  it('解析目录时按批回报进度，最后一定是「全部」', async () => {
    const { file } = countingFile(await sampleArchive())
    const seen: { parsed: number; total: number }[] = []
    await openArchive(file, (parsed, total) => seen.push({ parsed, total }))
    expect(seen[0]).toEqual({ parsed: 0, total: 6 })
    expect(seen[seen.length - 1]).toEqual({ parsed: 6, total: 6 })
  })

  it('超过内存上限退回按块读文件，内容仍然一致', async () => {
    const { file, counts } = countingFile(await sampleArchive())
    // 上限压到 100 字节，逼它走流式分支
    const archive = await openArchive(file, undefined, undefined, 100)
    expect(counts.arrayBuffer).toBe(0)
    expect(counts.slice).toBeGreaterThan(0)
    const texts: string[] = []
    for await (const entry of readArchive(archive)) {
      texts.push(await readEntryText(entry))
    }
    expect(texts).toHaveLength(6)
    expect(texts.some((text) => text.includes('export_format_version'))).toBe(true)
  })
})

describe('读条目内容', () => {
  it('文本条目解码后与原内容一致', async () => {
    const { file } = countingFile(await sampleArchive())
    const archive = await openArchive(file)
    for await (const entry of readArchive(archive)) {
      const text = await readEntryText(entry)
      expect(text.length).toBeGreaterThan(0)
      if (entry.path === 'manifest.json') {
        expect(JSON.parse(text)).toEqual({ export_format_version: 3 })
      }
    }
  })

  it('readEntryBytes 长度等于目录里的解压大小', async () => {
    const { file } = countingFile(await sampleArchive())
    const archive = await openArchive(file)
    for await (const entry of readArchive(archive)) {
      const bytes = await readEntryBytes(entry)
      expect(bytes.length).toBe(entry.size)
      if (entry.path === 'manifest.json') {
        expect(new TextDecoder().decode(bytes)).toContain('export_format_version')
      }
    }
  })

  it('readEntryBlob 按块收集，字节与解压大小一致', async () => {
    const { file } = countingFile(await sampleArchive())
    const archive = await openArchive(file)
    for await (const entry of readArchive(archive)) {
      const blob = await readEntryBlob(entry)
      expect(blob.size).toBe(entry.size)
    }
  })

  it('不是 ZIP 的文件打开就失败，且标明是格式不匹配', async () => {
    const file = new File([new Blob(['not a zip at all'])], 'x.zip')
    await expect(openArchive(file)).rejects.toBeInstanceOf(ArchiveFormatError)
    // 仍然是 ArchiveError 的子类：老调用方的兜底分支不会被绕过
    await expect(openArchive(file)).rejects.toBeInstanceOf(ArchiveError)
  })

  it('截断的包打开就失败，不会假装能读', async () => {
    const blob = await sampleArchive()
    const cut = new File([blob.slice(0, Math.floor(blob.size / 2))], 'cut.zip')
    const error = await openArchive(cut).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ArchiveError)
    expect(error).not.toBeInstanceOf(ArchiveFormatError)
  })
})
