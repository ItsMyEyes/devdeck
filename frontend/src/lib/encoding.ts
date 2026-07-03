// Base64 / URL encode-decode helpers shared by the Base64, URL, and JWT dev tools.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toUrlSafe(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromUrlSafe(b64url: string): string {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const padLength = (4 - (padded.length % 4)) % 4
  return padded + '='.repeat(padLength)
}

/** Encodes raw bytes as base64 (or base64url when `urlSafe`). */
export function base64EncodeBytes(bytes: Uint8Array, urlSafe = false): string {
  const b64 = bytesToBase64(bytes)
  return urlSafe ? toUrlSafe(b64) : b64
}

/** Decodes base64 (or base64url) to raw bytes. Throws on malformed input. */
export function base64DecodeBytes(input: string, urlSafe = false): Uint8Array<ArrayBuffer> {
  const compact = input.trim().replace(/\s+/g, '')
  if (!compact) throw new Error('Nothing to decode')
  const normal = urlSafe ? fromUrlSafe(compact) : compact
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normal)) {
    throw new Error('Not valid base64')
  }
  try {
    return base64ToBytes(normal)
  } catch {
    throw new Error('Not valid base64')
  }
}

/** UTF-8 text -> base64 (or base64url). */
export function encodeBase64Text(text: string, urlSafe = false): string {
  return base64EncodeBytes(new TextEncoder().encode(text), urlSafe)
}

/** base64 (or base64url) -> UTF-8 text. Throws if the input is malformed or the bytes aren't valid UTF-8. */
export function decodeBase64Text(input: string, urlSafe = false): string {
  const bytes = base64DecodeBytes(input, urlSafe)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Decoded bytes are not valid UTF-8 text')
  }
}

/** JWT-flavored base64url of raw bytes (no padding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  return base64EncodeBytes(bytes, true)
}

/** JWT-flavored base64url decode to raw bytes. */
export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  return base64DecodeBytes(input, true)
}

export type UrlEncodeMode = 'component' | 'full'

/** encodeURIComponent (component mode) or encodeURI (full mode, preserves URL-structural characters). */
export function encodeUrl(text: string, mode: UrlEncodeMode): string {
  return mode === 'full' ? encodeURI(text) : encodeURIComponent(text)
}

/** decodeURIComponent (component mode) or decodeURI (full mode). Throws on malformed percent-escapes. */
export function decodeUrl(text: string, mode: UrlEncodeMode): string {
  try {
    return mode === 'full' ? decodeURI(text) : decodeURIComponent(text)
  } catch {
    throw new Error('Malformed percent-encoding')
  }
}
