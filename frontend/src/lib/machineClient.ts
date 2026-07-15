// Direct-first client for runtime machines: every node shares one Tailscale
// tailnet, so REST and WebSocket requests try the machine's own URL first
// and fall back to the hub's reverse-proxy fallback path on failure.
// See docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md.

import type { Machine } from '@/store/types'
import { ApiError, request, type RequestOpts } from './api'

const DIRECT_PROBE_TIMEOUT_MS = 1500
const MODE_TTL_MS = 30_000

type Mode = 'direct' | 'proxy'

const modeCache = new Map<string, { mode: Mode; checkedAt: number }>()

/** ws:// or wss:// + host, matching the page's own protocol (mirrors the pattern in terminalClient.ts). */
function pageWsOrigin(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}`
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function directRestBase(machine: Machine): string {
  return `${trimSlash(machine.url)}/api`
}

function directWsBase(machine: Machine): string {
  return `${trimSlash(machine.url).replace(/^http/, 'ws')}/ws`
}

function proxyRestBase(machine: Machine): string {
  return `/api/machines/${machine.id}/proxy/api`
}

function proxyWsBase(machine: Machine): string {
  return `${pageWsOrigin()}/api/machines/${machine.id}/proxy/ws`
}

async function probeDirect(machine: Machine): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), DIRECT_PROBE_TIMEOUT_MS)
    const res = await fetch(`${trimSlash(machine.url)}/api/health`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${machine.key}` },
    })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Resolves whether a machine is reachable direct or needs the hub-proxy
 * fallback, caching the answer briefly so a burst of calls (e.g. opening a
 * worktree, which fires several queries at once) doesn't each re-probe.
 */
export async function resolveMachineMode(machine: Machine): Promise<Mode> {
  const cached = modeCache.get(machine.id)
  if (cached && Date.now() - cached.checkedAt < MODE_TTL_MS) return cached.mode
  const mode: Mode = (await probeDirect(machine)) ? 'direct' : 'proxy'
  modeCache.set(machine.id, { mode, checkedAt: Date.now() })
  return mode
}

export async function resolveMachineRest(machine: Machine): Promise<RequestOpts> {
  const mode = await resolveMachineMode(machine)
  return mode === 'direct'
    ? { base: directRestBase(machine), headers: { Authorization: `Bearer ${machine.key}` } }
    : { base: proxyRestBase(machine) }
}

/** Issues a request against a machine's runtime, direct-first with hub-proxy fallback. */
export async function machineRequest<T>(
  machine: Machine,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const opts = await resolveMachineRest(machine)
  return request<T>(method, path, body, opts)
}

async function toMachineApiError(res: Response): Promise<ApiError> {
  let message = `Request failed with status ${res.status}`
  try {
    const data = (await res.json()) as { error?: string }
    if (data && typeof data.error === 'string') message = data.error
  } catch {
    // Binary or empty error response; keep the default message.
  }
  if (res.status === 403 && message.startsWith('access denied') && window.location.pathname !== '/access-denied') {
    window.location.assign('/access-denied')
  }
  return new ApiError(message, res.status)
}

/** Raw machine fetch for multipart uploads and Blob downloads. */
export async function machineFetch(machine: Machine, path: string, init: RequestInit): Promise<Response> {
  const opts = await resolveMachineRest(machine)
  const headers = new Headers(init.headers)
  for (const [key, value] of Object.entries(opts.headers ?? {})) {
    if (!headers.has(key)) headers.set(key, value)
  }

  let res: Response
  try {
    res = await fetch(`${opts.base ?? ''}${path}`, { ...init, headers })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network request failed'
    throw new ApiError(message, 0)
  }
  if (!res.ok) throw await toMachineApiError(res)
  return res
}

export interface TransferProgress {
  loaded: number
  total: number
}

interface XhrRequestOpts {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: XMLHttpRequestBodyInit | null
  headers?: Record<string, string>
  onUploadProgress?: (progress: TransferProgress) => void
  onDownloadProgress?: (progress: TransferProgress) => void
  responseType: 'json' | 'blob'
}

/**
 * Like machineFetch, but via XMLHttpRequest so upload/download progress
 * events are available — fetch() doesn't expose upload progress in a
 * reliably supported way, and download progress via fetch needs a
 * ReadableStream reader loop that's more code than this for the same result.
 */
export async function machineXhr<T>(machine: Machine, opts: XhrRequestOpts): Promise<T> {
  const resolved = await resolveMachineRest(machine)
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(opts.method, `${resolved.base ?? ''}${opts.path}`)
    xhr.responseType = opts.responseType
    for (const [key, value] of Object.entries({ ...resolved.headers, ...opts.headers })) {
      xhr.setRequestHeader(key, value)
    }
    if (opts.onUploadProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) opts.onUploadProgress?.({ loaded: event.loaded, total: event.total })
      }
    }
    if (opts.onDownloadProgress) {
      xhr.onprogress = (event) => {
        if (event.lengthComputable) opts.onDownloadProgress?.({ loaded: event.loaded, total: event.total })
      }
    }
    xhr.onerror = () => reject(new ApiError('Network request failed', 0))
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as T)
        return
      }
      if (opts.responseType === 'blob') {
        reject(new ApiError(`Request failed with status ${xhr.status}`, xhr.status))
        return
      }
      const data = xhr.response as { error?: string } | null
      const message = data && typeof data.error === 'string' ? data.error : `Request failed with status ${xhr.status}`
      reject(new ApiError(message, xhr.status))
    }
    xhr.send(opts.body ?? null)
  })
}

/**
 * WS URL for a machine's runtime, direct-first with hub-proxy fallback.
 * In direct mode the runtime's key rides the `key` query param (the
 * browser WebSocket API cannot set headers); in proxy mode the page's own
 * hub auth already covers the request and no key is added.
 */
export async function machineWsUrl(
  machine: Machine,
  path: string,
  params: Record<string, string>,
): Promise<string> {
  const mode = await resolveMachineMode(machine)
  const query = new URLSearchParams(params)
  if (mode === 'direct') {
    query.set('key', machine.key)
    return `${directWsBase(machine)}${path}?${query.toString()}`
  }
  return `${proxyWsBase(machine)}${path}?${query.toString()}`
}
