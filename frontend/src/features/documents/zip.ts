// A read-only ZIP reader, because every Office Open XML file (.docx, .xlsx,
// .pptx) is a zip of XML parts and DevDeck ships no zip library.
//
// Why hand-rolled rather than a dependency: the read side of the format is
// small — walk the central directory, then inflate each wanted entry with
// the platform's own `DecompressionStream('deflate-raw')`. That is the whole
// job. Pulling in a zip library to do it would add a bundle for something the
// web platform already implements natively.
//
// Scope is deliberately "what Office writes": stored and deflated entries,
// and ZIP64 sizes/offsets. No encryption, no multi-disk archives, no
// legacy compression methods.

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

const EOCD_MIN_SIZE = 22
/** A ZIP comment is a u16 length, so the EOCD starts at most this far from the end. */
const MAX_COMMENT_SIZE = 0xffff

const METHOD_STORED = 0
const METHOD_DEFLATE = 8

/** Sentinel written into a 32-bit field whose real value lives in a ZIP64 extra field. */
const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  /** Offset of the entry's *local* header, which is where its data lives. */
  headerOffset: number
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipFormatError'
  }
}

/**
 * A parsed central directory plus the bytes it indexes. Entry data is
 * inflated lazily by `read`, so opening a 40 MB deck to show slide 1 does not
 * decompress its other 39 MB of embedded media.
 */
export class ZipArchive {
  private readonly data: Uint8Array
  private readonly view: DataView
  private readonly entries: Map<string, ZipEntry>

  constructor(data: Uint8Array, entries: Map<string, ZipEntry>) {
    this.data = data
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    this.entries = entries
  }

  names(): string[] {
    return [...this.entries.keys()]
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  /** Entry names under a folder prefix, e.g. `ppt/slides/`. */
  namesUnder(prefix: string): string[] {
    return this.names().filter((name) => name.startsWith(prefix))
  }

  async read(name: string): Promise<Uint8Array> {
    const entry = this.entries.get(name)
    if (!entry) throw new ZipFormatError(`${name} is missing from this file`)

    const { headerOffset } = entry
    if (headerOffset + 30 > this.data.byteLength) {
      throw new ZipFormatError(`${name} points past the end of the file`)
    }
    if (this.view.getUint32(headerOffset, true) !== LOCAL_SIGNATURE) {
      throw new ZipFormatError(`${name} has a corrupt local header`)
    }
    // The local header repeats the name and extra field, and its extra field
    // is routinely a *different length* from the central directory's — so the
    // data offset has to be computed from the local header's own lengths.
    const nameLength = this.view.getUint16(headerOffset + 26, true)
    const extraLength = this.view.getUint16(headerOffset + 28, true)
    const start = headerOffset + 30 + nameLength + extraLength
    const end = start + entry.compressedSize
    if (end > this.data.byteLength) {
      throw new ZipFormatError(`${name} is truncated`)
    }

    const raw = this.data.subarray(start, end)
    if (entry.method === METHOD_STORED) return raw
    if (entry.method === METHOD_DEFLATE) return inflateRaw(raw)
    throw new ZipFormatError(`${name} uses unsupported compression method ${entry.method}`)
  }

  async readText(name: string): Promise<string> {
    return new TextDecoder().decode(await this.read(name))
  }

  /** `read`, but resolving to null for an absent entry — most OOXML parts are optional. */
  async readOptional(name: string): Promise<Uint8Array | null> {
    if (!this.has(name)) return null
    return this.read(name)
  }
}

export function readZip(data: Uint8Array): ZipArchive {
  if (data.byteLength < EOCD_MIN_SIZE) {
    throw new ZipFormatError('This file is too small to be a valid Office file')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const eocd = findEndOfCentralDirectory(view, data.byteLength)
  if (eocd < 0) {
    throw new ZipFormatError('This file is not a valid Office file (no zip directory found)')
  }

  let entryCount = view.getUint16(eocd + 10, true)
  let centralOffset = view.getUint32(eocd + 16, true)

  // ZIP64 kicks in past 65535 entries or 4 GB, and Office does produce it for
  // large decks with embedded video.
  if (entryCount === U16_MAX || centralOffset === U32_MAX) {
    const zip64 = readZip64Locator(view, eocd)
    if (zip64) {
      entryCount = zip64.entryCount
      centralOffset = zip64.centralOffset
    }
  }

  const entries = new Map<string, ZipEntry>()
  let offset = centralOffset
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > data.byteLength) {
      throw new ZipFormatError('This file has a truncated zip directory')
    }
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError('This file has a corrupt zip directory')
    }

    const method = view.getUint16(offset + 10, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)

    const name = new TextDecoder().decode(data.subarray(offset + 46, offset + 46 + nameLength))
    const extra = data.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength)

    const sizes = resolveZip64Sizes(extra, {
      uncompressedSize: view.getUint32(offset + 24, true),
      compressedSize: view.getUint32(offset + 20, true),
      headerOffset: view.getUint32(offset + 42, true),
    })

    // Directory entries are zero-length markers; nothing ever reads one.
    if (!name.endsWith('/')) {
      entries.set(name, { name, method, ...sizes })
    }
    offset += 46 + nameLength + extraLength + commentLength
  }

  return new ZipArchive(data, entries)
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  const earliest = Math.max(0, length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE)
  for (let offset = length - EOCD_MIN_SIZE; offset >= earliest; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset
  }
  return -1
}

function readZip64Locator(
  view: DataView,
  eocd: number,
): { entryCount: number; centralOffset: number } | null {
  const locator = eocd - 20
  if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) return null

  const record = toSafeNumber(view.getBigUint64(locator + 8, true), 'zip64 directory offset')
  if (record + 56 > view.byteLength) return null
  if (view.getUint32(record, true) !== ZIP64_EOCD_SIGNATURE) return null

  return {
    entryCount: toSafeNumber(view.getBigUint64(record + 32, true), 'zip64 entry count'),
    centralOffset: toSafeNumber(view.getBigUint64(record + 48, true), 'zip64 directory offset'),
  }
}

interface EntrySizes {
  uncompressedSize: number
  compressedSize: number
  headerOffset: number
}

/**
 * Replaces any 0xFFFFFFFF placeholder with the real value from the entry's
 * ZIP64 extra field (header id 0x0001). The extra field packs only the fields
 * that overflowed, in a fixed order — so which values are present depends
 * entirely on which 32-bit fields were saturated.
 */
function resolveZip64Sizes(extra: Uint8Array, base: EntrySizes): EntrySizes {
  const needed =
    (base.uncompressedSize === U32_MAX ? 1 : 0) +
    (base.compressedSize === U32_MAX ? 1 : 0) +
    (base.headerOffset === U32_MAX ? 1 : 0)
  if (needed === 0 || extra.byteLength < 4) return base

  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
  let offset = 0
  while (offset + 4 <= extra.byteLength) {
    const headerId = view.getUint16(offset, true)
    const size = view.getUint16(offset + 2, true)
    if (headerId !== 0x0001) {
      offset += 4 + size
      continue
    }

    const resolved = { ...base }
    let cursor = offset + 4
    const next = (label: string) => {
      const value = toSafeNumber(view.getBigUint64(cursor, true), label)
      cursor += 8
      return value
    }
    if (resolved.uncompressedSize === U32_MAX && cursor + 8 <= offset + 4 + size) {
      resolved.uncompressedSize = next('zip64 uncompressed size')
    }
    if (resolved.compressedSize === U32_MAX && cursor + 8 <= offset + 4 + size) {
      resolved.compressedSize = next('zip64 compressed size')
    }
    if (resolved.headerOffset === U32_MAX && cursor + 8 <= offset + 4 + size) {
      resolved.headerOffset = next('zip64 header offset')
    }
    return resolved
  }
  return base
}

function toSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipFormatError(`This file is too large to open (${label} overflows)`)
  }
  return Number(value)
}

/**
 * Raw-deflate inflate via the platform's own decompressor.
 *
 * Streams rather than `new Response(blob).arrayBuffer()` so this works
 * identically under jsdom in tests, where `ReadableStream` and
 * `DecompressionStream` exist but Blob's stream plumbing is patchier.
 */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new ZipFormatError('This browser cannot decompress Office files')
  }

  // A fresh, ArrayBuffer-backed copy of the compressed bytes. `bytes` is a
  // subarray of the archive and so is typed over ArrayBufferLike (it could in
  // principle be a SharedArrayBuffer), which `DecompressionStream.writable`
  // does not accept. Copying the *compressed* extent is cheap next to the
  // inflate it feeds.
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)

  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(input)
      controller.close()
    },
  })

  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = value as Uint8Array
    chunks.push(chunk)
    total += chunk.byteLength
  }

  const out = new Uint8Array(total)
  let written = 0
  for (const chunk of chunks) {
    out.set(chunk, written)
    written += chunk.byteLength
  }
  return out
}
