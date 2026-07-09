// Client-side helpers for the xterm.js <-> terminal-gateway WebSocket.
// Mirrors the protocol in server/terminal-server.mjs.

import type { Machine } from '@/store/types'
import { machineWsUrl } from './machineClient'

export interface InputFrame {
  t: 'i'
  d: string
}
export interface ResizeFrame {
  t: 'r'
  cols: number
  rows: number
}
export type ClientFrame = InputFrame | ResizeFrame

/** Build the terminal WebSocket URL, direct-first with hub-proxy fallback. */
export function terminalWsUrl(machine: Machine, session: string, cols: number, rows: number): Promise<string> {
  return machineWsUrl(machine, '/terminal', { session, cols: String(cols), rows: String(rows) })
}

export function inputFrame(d: string): string {
  return JSON.stringify({ t: 'i', d } satisfies InputFrame)
}
export function resizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ t: 'r', cols, rows } satisfies ResizeFrame)
}
