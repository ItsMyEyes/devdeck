// Client-side helpers for the xterm.js <-> terminal-gateway WebSocket.
// Mirrors the protocol in server/terminal-server.mjs.

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

/** Build the terminal WebSocket URL (proxied by Vite to the gateway in dev). */
export function terminalWsUrl(session: string, cols: number, rows: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const params = new URLSearchParams({ session, cols: String(cols), rows: String(rows) })
  return `${proto}://${window.location.host}/ws/terminal?${params.toString()}`
}

export function inputFrame(d: string): string {
  return JSON.stringify({ t: 'i', d } satisfies InputFrame)
}
export function resizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ t: 'r', cols, rows } satisfies ResizeFrame)
}
