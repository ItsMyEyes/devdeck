// Lossless gzip (DEFLATE + CRC32) compression via the browser-native
// Compression Streams API - no install, no network round-trip, no external
// binary. gzip's trailer carries a CRC32 of the uncompressed data, and
// DecompressionStream validates it: a corrupted stream throws here instead
// of silently decompressing to the wrong bytes.

async function pipeThrough(bytes: Uint8Array<ArrayBuffer>, transform: GenericTransformStream): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(transform)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export function gzipCompress(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return pipeThrough(bytes, new CompressionStream('gzip'))
}

/** Throws if `bytes` isn't a valid gzip stream, or if its CRC32 trailer doesn't match. */
export function gzipDecompress(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return pipeThrough(bytes, new DecompressionStream('gzip'))
}
