// JWT decode/sign/verify for the JWT dev tool. Uses the browser's native
// Web Crypto (SubtleCrypto) for HMAC and RSA — no jwt library dependency.
import { base64DecodeBytes, base64UrlDecode, base64UrlEncode } from './encoding'

export type JwtAlgorithm = 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512'

interface AlgSpec {
  family: 'hmac' | 'rsa'
  hash: 'SHA-256' | 'SHA-384' | 'SHA-512'
}

const ALGS: Record<JwtAlgorithm, AlgSpec> = {
  HS256: { family: 'hmac', hash: 'SHA-256' },
  HS384: { family: 'hmac', hash: 'SHA-384' },
  HS512: { family: 'hmac', hash: 'SHA-512' },
  RS256: { family: 'rsa', hash: 'SHA-256' },
  RS384: { family: 'rsa', hash: 'SHA-384' },
  RS512: { family: 'rsa', hash: 'SHA-512' },
}

export const JWT_ALGORITHMS = Object.keys(ALGS) as JwtAlgorithm[]

/** 'hmac' keys are a plain secret string; 'rsa' keys are PEM (PKCS8 private / SPKI public). */
export function jwtKeyFamily(alg: string | null): 'hmac' | 'rsa' | null {
  if (!alg) return null
  return (ALGS as Record<string, AlgSpec | undefined>)[alg]?.family ?? null
}

export interface DecodedJwt {
  header: unknown
  payload: unknown
  signature: string
  signingInput: string
  alg: string | null
}

/** Splits and decodes a JWT's header/payload without verifying the signature. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.trim().split('.')
  if (parts.length !== 3) {
    throw new Error('A JWT must have 3 dot-separated parts (header.payload.signature)')
  }
  const [headerB64, payloadB64, signature] = parts

  let header: unknown
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)))
  } catch {
    throw new Error('Header is not valid base64url-encoded JSON')
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)))
  } catch {
    throw new Error('Payload is not valid base64url-encoded JSON')
  }

  const alg =
    header !== null && typeof header === 'object' && 'alg' in header
      ? String((header as Record<string, unknown>).alg)
      : null

  return { header, payload, signature, signingInput: `${headerB64}.${payloadB64}`, alg }
}

/** Extracts the PEM label ("PUBLIC KEY", "RSA PRIVATE KEY", …) and the underlying DER bytes. */
function decodePem(pem: string): { label: string; der: Uint8Array<ArrayBuffer> } {
  const match = pem.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/)
  if (!match) throw new Error('Not a valid PEM key (expected a -----BEGIN ... KEY----- block)')
  return { label: match[1].trim(), der: base64DecodeBytes(match[2]) }
}

const RSA_ENCRYPTION_ALGORITHM_IDENTIFIER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
])

/** DER length octets (definite, short or long form) for a content length up to 16MB. */
function derLength(len: number): number[] {
  if (len < 0x80) return [len]
  if (len < 0x100) return [0x81, len]
  if (len < 0x10000) return [0x82, (len >> 8) & 0xff, len & 0xff]
  return [0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]
}

/**
 * Wraps a traditional PKCS1 RSA private key DER (the format `openssl genrsa` produces,
 * "-----BEGIN RSA PRIVATE KEY-----") into a PKCS8 PrivateKeyInfo structure, which is the only
 * format Web Crypto's `importKey('pkcs8', …)` accepts.
 */
function pkcs1RsaToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = new Uint8Array([0x02, 0x01, 0x00])
  const octetString = new Uint8Array([0x04, ...derLength(pkcs1.length), ...pkcs1])
  const body = new Uint8Array([...version, ...RSA_ENCRYPTION_ALGORITHM_IDENTIFIER, ...octetString])
  return new Uint8Array([0x30, ...derLength(body.length), ...body])
}

/** Parses an RSA private key PEM (PKCS1 or PKCS8) into PKCS8 DER bytes for `importKey('pkcs8', …)`. */
function rsaPrivateKeyToPkcs8(pem: string): ArrayBuffer {
  const { label, der } = decodePem(pem)
  if (label.includes('RSA PRIVATE KEY')) return pkcs1RsaToPkcs8(der).buffer
  if (label === 'PRIVATE KEY') return der.buffer
  throw new Error(`Expected a PRIVATE KEY or RSA PRIVATE KEY PEM block, got "${label}"`)
}

/** Parses an RSA public key PEM (SPKI, e.g. `openssl rsa -pubout`) into DER bytes for `importKey('spki', …)`. */
function rsaPublicKeyToSpki(pem: string): ArrayBuffer {
  const { label, der } = decodePem(pem)
  if (label !== 'PUBLIC KEY') throw new Error(`Expected a PUBLIC KEY PEM block, got "${label}"`)
  return der.buffer
}

export interface VerifyJwtResult {
  valid: boolean
  alg: string
}

/** Verifies a JWT's signature. `key` is the HMAC secret for HS*, or a PEM public key (SPKI) for RS*. */
export async function verifyJwt(token: string, key: string): Promise<VerifyJwtResult> {
  const decoded = decodeJwt(token)
  const alg = decoded.alg
  if (!alg || !(alg in ALGS)) throw new Error(`Unsupported or missing algorithm: ${alg ?? 'none'}`)
  const spec = ALGS[alg as JwtAlgorithm]
  const signingInputBytes = new TextEncoder().encode(decoded.signingInput)
  const signatureBytes = base64UrlDecode(decoded.signature)

  if (spec.family === 'hmac') {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key),
      { name: 'HMAC', hash: spec.hash },
      false,
      ['verify'],
    )
    const valid = await crypto.subtle.verify('HMAC', cryptoKey, signatureBytes, signingInputBytes)
    return { valid, alg }
  }

  const cryptoKey = await crypto.subtle.importKey(
    'spki',
    rsaPublicKeyToSpki(key),
    { name: 'RSASSA-PKCS1-v1_5', hash: spec.hash },
    false,
    ['verify'],
  )
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signatureBytes, signingInputBytes)
  return { valid, alg }
}

export interface SignJwtInput {
  alg: JwtAlgorithm
  payload: unknown
  /** HMAC secret string for HS*, or a PEM private key (PKCS1 `openssl genrsa` or PKCS8) for RS*. */
  key: string
}

/** Signs a header+payload into a compact JWT. `key` is the HMAC secret for HS*, or a PEM private key (PKCS1/PKCS8) for RS*. */
export async function signJwt({ alg, payload, key }: SignJwtInput): Promise<string> {
  const spec = ALGS[alg]
  const header = { alg, typ: 'JWT' }
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)))
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`
  const signingInputBytes = new TextEncoder().encode(signingInput)

  let signatureBytes: ArrayBuffer
  if (spec.family === 'hmac') {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key),
      { name: 'HMAC', hash: spec.hash },
      false,
      ['sign'],
    )
    signatureBytes = await crypto.subtle.sign('HMAC', cryptoKey, signingInputBytes)
  } else {
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      rsaPrivateKeyToPkcs8(key),
      { name: 'RSASSA-PKCS1-v1_5', hash: spec.hash },
      false,
      ['sign'],
    )
    signatureBytes = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, signingInputBytes)
  }

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signatureBytes))}`
}
