// WS URL for an interactive SSH shell (server: backend/internal/sshmgr).
// Phase 1 always executes SSH sessions on the hub — the page's own origin —
// so unlike terminalClient.ts there is no per-machine direct-first
// resolution here yet; that arrives with ExecutorMachineID routing.

export function sshShellWsUrl(connectionId: string, cols: number, rows: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const query = new URLSearchParams({ connection: connectionId, cols: String(cols), rows: String(rows) })
  return `${proto}://${window.location.host}/ws/ssh?${query.toString()}`
}
