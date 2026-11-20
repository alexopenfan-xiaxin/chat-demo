import { describe, expect, it } from 'vitest'
import {
  ArchiveError,
  listArchivePaths,
  openArchive,
  readArchive,
  readEntryBytes,
  readEntryText,
} from '../src/services/chat/history/zipReader'
import { writeArchive } from '../src/services/chat/history/zipWriter'

/** 统计 File.slice 的调用次数：这个数就是「读了几次盘」 */
const countingFile = (blob: Blob) => {
  const file = new File([blob], 'history.zip', { type: 'application/zip' })
  let slices = 0
  const proxy = new Proxy(file, {
    get(target, prop, receiver) {
      if (prop === 'slice') {
        return (start?: number, end?: number) => {
          slices += 1
          return target.slice(start, end)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as File
  return { file: proxy, reads: () => slices }
}

const sampleArchive = () =>
  writeArchive([
    { name: 'manifest.json', blob: new Blob(['{"export_format_version":3}']) },
    ...Array.from({ length: 5 }, (_, index) => ({
      name: `chat_sessions/s${index}.json`,
      blob: new Blob([JSON.stringify({ id: `s${index}`, body: 'x'.repeat(2000) })]),
    })),
  ])

describe('openArchive（中央目录只读一次）', () => {
  it('目录条目再多，读取次数也不随条目数增长', async () => {
    const { file, reads } = countingFile(await sampleArchive())
    const before = reads()
    const archive = await openArchive(file)
    // 4 字节签名 + EOCD 尾巴 + 整段中央目录，三次读就够了
    expect(reads() - before).toBeLessThanOrEqual(3)
    expect(archive.entries).toHaveLength(6)
    expect(archive.entries.filter((entry) => entry.path.startsWith('chat_sessions/'))).toHaveLength(5)
  })

  it('列目录是纯内存操作，不再碰文件', async () => {
    const { file, reads } = countingFile(await sampleArchive())
    const archive = await openArchive(file)
    const before = reads()
    const paths = listArchivePaths(archive)
    expect(paths).toContain('manifest.json')
    expect(reads() - before).toBe(0)
  })

  it('解析目录时按批回报进度，最后一定是「全部」', async () => {
    const { file } = countingFile(await sampleArchive())
    const seen: { parsed: number; total: number }[] = []
    await openArchive(file, (parsed, total) => seen.push({ parsed, total }))
    expect(seen[0]).toEqual({ parsed: 0, total: 6 })
    expect(seen[seen.length - 1]).toEqual({ parsed: 6, total: 6 })
  })

  it('条目再多也只在目录里解析一次：同一条目流只读当前条目', async () => {
    const { file, reads } = countingFile(await sampleArchive())
    const archive = await openArchive(file)
    const before = reads()
    for await (const entry of readArchive(archive)) {
      await readEntryText(entry)
    }
    // 每个条目 4 次：本地头、名字+extra、descriptor、数据块；目录本身不再读
    expect(reads() - before).toBeLessThanOrEqual(24)
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

  it('不是 ZIP 的文件打开就失败', async () => {
    const file = new File([new Blob(['not a zip at all'])], 'x.zip')
    await expect(openArchive(file)).rejects.toBeInstanceOf(ArchiveError)
  })

  it('截断的包打开就失败，不会假装能读', async () => {
    const blob = await sampleArchive()
    const cut = new File([blob.slice(0, Math.floor(blob.size / 2))], 'cut.zip')
    await expect(openArchive(cut)).rejects.toBeInstanceOf(ArchiveError)
  })
})
