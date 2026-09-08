// Text hashing for the Hash Generator dev tool, via native Web Crypto digest.

export const HASH_ALGORITHMS = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number]

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Hex digest of arbitrary bytes under the given algorithm. */
export async function digestHexBytes(bytes: BufferSource, algo: HashAlgorithm): Promise<string> {
  const digest = await crypto.subtle.digest(algo, bytes)
  return bytesToHex(digest)
}

/** Hex digest of UTF-8 text under the given algorithm. */
export function digestHex(text: string, algo: HashAlgorithm): Promise<string> {
  return digestHexBytes(new TextEncoder().encode(text), algo)
}
