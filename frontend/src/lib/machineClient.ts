// Direct-first client for runtime machines: every node shares one Tailscale
// tailnet, so REST and WebSocket requests try the machine's own URL first
// and fall back to the hub's reverse-proxy fallback path on failure.
// See docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md.

import type { Machine } from '@/store/types'
import { request, type RequestOpts } from './api'

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

async function resolveMachineRest(machine: Machine): Promise<RequestOpts> {
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
