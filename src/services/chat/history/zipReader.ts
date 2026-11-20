import { Inflate } from 'fflate'

const READ_CHUNK_BYTES = 256 * 1024
/** 解析中央目录时每这么多条报一次进度，太少会变成刷屏，太多会显不出「在动」 */
const DIRECTORY_PROGRESS_EVERY = 32
/** 单条目内联读进内存的上限；超过就退回按块建 Blob，避免大附件整个压进 JS 堆 */
const INLINE_ENTRY_LIMIT = 8 * 1024 * 1024
// 控制每轮同步解压的工作量；输出交给调用方保存后才继续读取。
const INFLATE_CHUNK_BYTES = 8 * 1024

/** ZIP 结构损坏或使用了不支持的特性 */
export class ArchiveError extends Error {
  constructor() {
    super('Invalid or unsupported history archive')
    this.name = 'ArchiveError'
  }
}

/**
 * 解压与校验的细分计时：CRC 是纯 JS 逐字节算的，安卓上到底占多少只能实测。
 * 由调用方临时挂上，导入结束摘掉；不挂时开销为零。
 */
export type StreamTiming = (kind: 'crc' | 'inflate', ms: number) => void
let streamTiming: StreamTiming | null = null
export const setStreamTiming = (timing: StreamTiming | null) => {
  streamTiming = timing
}

/** 中央目录解析进度：已解析条数 / 总条数（总数来自 EOCD，一开始就知道） */
export type DirectoryProgress = (parsed: number, total: number) => void

const invalid = (): never => {
  throw new ArchiveError()
}

/** 本地文件头签名 PK\x03\x04，用于在解析前区分 ZIP 与其他文件。 */
export const isZipFile = async (file: File) => {
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return bytes.length === 4 && bytes.every((byte, index) => byte === [0x50, 0x4b, 3, 4][index])
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

const readBytes = async (file: File, start: number, length: number) => {
  if (start < 0 || length < 0 || start + length > file.size) {
    invalid()
  }
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer())
  if (bytes.length !== length) {
    invalid()
  }
  return bytes
}

/** ZIP64、分卷与加密文件不属于导出格式，一律拒绝。 */
const checkExtra = (bytes: Uint8Array) => {
  const view = viewOf(bytes)
  let offset = 0
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length || view.getUint16(offset, true) === 1) {
      invalid()
    }
    offset += 4 + view.getUint16(offset + 2, true)
    if (offset > bytes.length) {
      invalid()
    }
  }
}

const decodePath = (bytes: Uint8Array, flags: number) => {
  // 非 UTF-8 编码的 ZIP 文件名仅接受 ASCII，确保附件路径解码准确。
  if (!(flags & 0x800) && bytes.some((byte) => byte > 0x7f)) {
    invalid()
  }
  const path = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
  if (!path || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) {
    invalid()
  }
  const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    invalid()
  }
  return path
}

/** 中央目录里的一条记录 */
export type Entry = {
  path: string
  name: Uint8Array
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
}

/**
 * 读中央目录：整段一次读进内存再解析。
 * 之前是每个条目单独读 46 字节头、名字、extra，一条三次异步 slice，
 * 手机上每次 slice 都要过一次主线程调度，几百个条目就积成几秒。
 */
const readDirectory = async (
  file: File,
  onProgress?: DirectoryProgress
): Promise<{ entries: Entry[]; offset: number }> => {
  if (file.size < 22) {
    invalid()
  }
  const tailStart = Math.max(0, file.size - 22 - 0xffff)
  const tail = await readBytes(file, tailStart, file.size - tailStart)
  const tailView = viewOf(tail)
  let end = tail.length - 22
  while (
    end >= 0 &&
    (tailView.getUint32(end, true) !== 0x06054b50 ||
      end + 22 + tailView.getUint16(end + 20, true) !== tail.length)
  ) {
    end--
  }
  if (end < 0) {
    invalid()
  }
  const count = tailView.getUint16(end + 10, true)
  const size = tailView.getUint32(end + 12, true)
  const offset = tailView.getUint32(end + 16, true)
  if (
    tailView.getUint16(end + 4, true) !== 0 ||
    tailView.getUint16(end + 6, true) !== 0 ||
    tailView.getUint16(end + 8, true) !== count ||
    count === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    offset + size !== tailStart + end
  ) {
    invalid()
  }
  const entries: Entry[] = []
  const paths = new Set<string>()
  // 整段读一次：中央目录通常几十 KB，读进内存后逐条解析不再有 I/O
  const directory = await readBytes(file, offset, size)
  onProgress?.(0, count)
  let cursor = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > size) {
      invalid()
    }
    const view = viewOf(directory.subarray(cursor))
    if (view.getUint32(0, true) !== 0x02014b50) {
      invalid()
    }
    const flags = view.getUint16(8, true)
    const method = view.getUint16(10, true)
    const compressedSize = view.getUint32(20, true)
    const entrySize = view.getUint32(24, true)
    const nameLength = view.getUint16(28, true)
    const extraLength = view.getUint16(30, true)
    const next = cursor + 46 + nameLength + extraLength + view.getUint16(32, true)
    const entryOffset = view.getUint32(42, true)
    // 只允许 deflate 选项、data descriptor 与 UTF-8 标志。
    if (
      flags & ~0x80e ||
      (method !== 0 && method !== 8) ||
      compressedSize === 0xffffffff ||
      entrySize === 0xffffffff ||
      (method === 0 && compressedSize !== entrySize) ||
      entryOffset >= offset ||
      view.getUint16(34, true) !== 0 ||
      ((view.getUint32(38, true) >>> 16) & 0xf000) === 0xa000 ||
      next > size
    ) {
      invalid()
    }
    const name = directory.subarray(cursor + 46, cursor + 46 + nameLength)
    const path = decodePath(name, flags)
    // 目录和同名文件也不能互相覆盖。
    const identity = path.endsWith('/') ? path.slice(0, -1) : path
    if (paths.has(identity) || (path.endsWith('/') && entrySize !== 0)) {
      invalid()
    }
    paths.add(identity)
    checkExtra(directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength))
    entries.push({
      path,
      name,
      flags,
      method,
      crc: view.getUint32(16, true),
      compressedSize,
      size: entrySize,
      offset: entryOffset,
    })
    cursor = next
    if ((index + 1) % DIRECTORY_PROGRESS_EVERY === 0) {
      onProgress?.(index + 1, count)
    }
  }
  if (cursor !== size) {
    invalid()
  }
  onProgress?.(count, count)
  return { entries: entries.sort((a, b) => a.offset - b.offset), offset }
}

const readEntryOffset = async (file: File, entry: Entry, boundary: number) => {
  if (entry.offset + 30 > boundary) {
    invalid()
  }
  const view = viewOf(await readBytes(file, entry.offset, 30))
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  const start = entry.offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (
    view.getUint32(0, true) !== 0x04034b50 ||
    view.getUint16(6, true) !== entry.flags ||
    view.getUint16(8, true) !== entry.method ||
    nameLength !== entry.name.length ||
    end > boundary
  ) {
    invalid()
  }
  for (const [position, expected] of [
    [14, entry.crc],
    [18, entry.compressedSize],
    [22, entry.size],
  ]) {
    const actual = view.getUint32(position, true)
    if (actual !== expected && (!(entry.flags & 8) || actual !== 0)) {
      invalid()
    }
  }
  // 名字与 extra 一次读完（原来分两次 slice）；descriptor 在压缩数据之后，只能单独读
  const metadata = await readBytes(file, entry.offset + 30, nameLength + extraLength)
  if (entry.name.some((byte, index) => byte !== metadata[index])) {
    invalid()
  }
  checkExtra(metadata.subarray(nameLength))
  if (entry.flags & 8) {
    if (end + 12 > boundary) {
      invalid()
    }
    const descriptor = viewOf(await readBytes(file, end, Math.min(16, boundary - end)))
    const shift = descriptor.getUint32(0, true) === 0x08074b50 ? 4 : 0
    if (
      shift + 12 > descriptor.byteLength ||
      descriptor.getUint32(shift, true) !== entry.crc ||
      descriptor.getUint32(shift + 4, true) !== entry.compressedSize ||
      descriptor.getUint32(shift + 8, true) !== entry.size
    ) {
      invalid()
    }
  }
  return start
}

/**
 * 打开归档：读一次中央目录，之后所有步骤复用同一个对象。
 *
 * 类型上强制「只读一次」——`checkFormat` 与 `import` 都只接受 Archive，
 * 想再扫一遍目录只能重新 openArchive，调用方一眼能看出来。
 */
export type Archive = {
  readonly file: File
  readonly entries: readonly Entry[]
  /** 中央目录的起始偏移，也是最后一个条目数据的边界 */
  readonly boundary: number
}

export const openArchive = async (file: File, onProgress?: DirectoryProgress): Promise<Archive> => {
  if (!(await isZipFile(file))) {
    invalid()
  }
  const { entries, offset } = await readDirectory(file, onProgress)
  return { file, entries, boundary: offset }
}

/**
 * 列出全部条目名：纯粹的内存操作，不再碰文件。
 * 读不出来（结构损坏）的包在 openArchive 就已经失败，不会走到这里。
 */
export const listArchivePaths = (archive: Archive): string[] =>
  archive.entries.map((entry) => entry.path)

export type ArchiveEntry = {
  path: string
  size: number
  stream: AsyncIterable<Uint8Array>
}

/**
 * 按条目在文件中的物理顺序逐条、逐块解压，跳过目录条目。
 * 调用方必须消费完当前条目的数据，再请求下一个条目。
 */
export async function* readArchive(archive: Archive): AsyncGenerator<ArchiveEntry> {
  const { file, entries } = archive
  for (const [index, entry] of entries.entries()) {
    const boundary = entries[index + 1]?.offset ?? archive.boundary
    const start = await readEntryOffset(file, entry, boundary)
    if (entry.path.endsWith('/')) {
      continue
    }
    let completed = false
    const stream = async function* (): AsyncGenerator<Uint8Array> {
      let written = 0
      let crc = 0xffffffff
      const pending: Uint8Array[] = []
      const append = (chunk: Uint8Array) => {
        written += chunk.length
        if (written > entry.size) {
          invalid()
        }
        const crcStarted = streamTiming ? performance.now() : 0
        for (const byte of chunk) {
          crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
        }
        if (streamTiming) {
          streamTiming('crc', performance.now() - crcStarted)
        }
        if (chunk.length) {
          pending.push(chunk)
        }
      }
      const inflate = entry.method === 8 ? new Inflate(append) : null
      for (let offset = 0; offset < entry.compressedSize; offset += READ_CHUNK_BYTES) {
        const chunk = await readBytes(
          file,
          start + offset,
          Math.min(READ_CHUNK_BYTES, entry.compressedSize - offset)
        )
        if (!inflate) {
          append(chunk)
          yield* pending.splice(0)
          continue
        }
        for (let cursor = 0; cursor < chunk.length; cursor += INFLATE_CHUNK_BYTES) {
          const end = Math.min(cursor + INFLATE_CHUNK_BYTES, chunk.length)
          const inflateStarted = streamTiming ? performance.now() : 0
          inflate.push(chunk.subarray(cursor, end), offset + end === entry.compressedSize)
          if (streamTiming) {
            streamTiming('inflate', performance.now() - inflateStarted)
          }
          // yield 暂停解压，等待调用方完成异步写入；不缓存整个条目。
          yield* pending.splice(0)
        }
      }
      if (inflate && entry.compressedSize === 0) {
        inflate.push(new Uint8Array(), true)
        yield* pending.splice(0)
      }
      if (written !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) {
        invalid()
      }
      completed = true
    }
    yield { path: entry.path, size: entry.size, stream: stream() }
    if (!completed) {
      invalid()
    }
  }
}

/**
 * 读出整个条目到内存：按 entry.size 预分配，逐块复制。
 *
 * 之前每块都建一个 Blob 再拼起来，400 个会话在 6x 降速下 5564ms；
 * 直接拼 Uint8Array 是 3485ms（实测）。大附件不走这条，避免整块压进 JS 堆。
 */
export const readEntryBytes = async (entry: ArchiveEntry): Promise<Uint8Array> => {
  const bytes = new Uint8Array(entry.size)
  let offset = 0
  for await (const chunk of entry.stream) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  if (offset !== entry.size) {
    invalid()
  }
  return bytes
}

/** 文本条目（会话 JSON、manifest、index）：解码一次，不经过 Blob。 */
export const readEntryText = async (entry: ArchiveEntry): Promise<string> => {
  if (entry.size > INLINE_ENTRY_LIMIT) {
    return (await readEntryBlob(entry)).text()
  }
  return new TextDecoder().decode(await readEntryBytes(entry))
}

/**
 * 大条目退回按块收集：附件可能几十 MB，整块进 JS 堆会顶内存上限。
 * 最后一次性建 Blob，不嵌套 Blob。
 */
export const readEntryBlob = async (entry: ArchiveEntry): Promise<Blob> => {
  const parts: Uint8Array[] = []
  let total = 0
  for await (const chunk of entry.stream) {
    parts.push(chunk)
    total += chunk.length
  }
  if (total !== entry.size) {
    invalid()
  }
  return new Blob(parts as BlobPart[])
}

/** 不需要的条目也要读完，以校验大小与 CRC。 */
export const skipEntry = async (entry: ArchiveEntry): Promise<void> => {
  const reader = entry.stream[Symbol.asyncIterator]()
  while (!(await reader.next()).done) {
    // 丢弃数据。
  }
}
