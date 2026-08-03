// Builds real ZIP archives in memory so the document readers can be tested
// against the actual byte format rather than a mocked-out zip layer.
//
// Test-only, but a plain module (not a .test.ts) so several test files can
// share it. Writes stored entries by default; `deflate: true` routes through
// `CompressionStream` to exercise the reader's inflate path.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(input)
      controller.close()
    },
  })
  const reader = source.pipeThrough(new CompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value as Uint8Array)
    total += (value as Uint8Array).byteLength
  }
  const out = new Uint8Array(total)
  let written = 0
  for (const chunk of chunks) {
    out.set(chunk, written)
    written += chunk.byteLength
  }
  return out
}

export interface ZipInput {
  [name: string]: string | Uint8Array
}

/** Builds a ZIP archive. `deflate` compresses every entry rather than storing it. */
export async function buildZip(files: ZipInput, options: { deflate?: boolean } = {}) {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === 'string' ? encoder.encode(content) : content
    const stored = options.deflate ? await deflateRaw(raw) : raw
    const method = options.deflate ? 8 : 0
    const nameBytes = encoder.encode(name)
    const crc = crc32(raw)

    const local = new Uint8Array(30 + nameBytes.length + stored.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0, true)
    localView.setUint16(8, method, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, stored.length, true)
    localView.setUint32(22, raw.length, true)
    localView.setUint16(26, nameBytes.length, true)
    localView.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    local.set(stored, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(10, method, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, stored.length, true)
    centralView.setUint32(24, raw.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, centrals.length, true)
  eocdView.setUint16(10, centrals.length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, offset, true)

  const total =
    locals.reduce((sum, entry) => sum + entry.length, 0) + centralSize + eocd.length
  const archive = new Uint8Array(total)
  let written = 0
  for (const part of [...locals, ...centrals, eocd]) {
    archive.set(part, written)
    written += part.length
  }
  return archive
}
