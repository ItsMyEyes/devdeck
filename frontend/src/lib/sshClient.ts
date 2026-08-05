// WS URL for an interactive SSH shell (server: backend/internal/sshmgr).
//
// Always the page's own origin, unlike terminalClient.ts's per-machine
// direct-first resolution — and that stays true now that ExecutorMachineID
// routing works. A worktree terminal's PTY *runs on* its machine, so the
// client must reach that machine; an SSH session's credentials live encrypted
// on the hub, so the hub stays the endpoint and only the outbound TCP dial
// moves to the executor (backend/internal/sshmgr/executor.go). The same
// reasoning applies to the SFTP file API in sshFileApi.ts.

export function sshShellWsUrl(connectionId: string, cols: number, rows: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const query = new URLSearchParams({ connection: connectionId, cols: String(cols), rows: String(rows) })
  return `${proto}://${window.location.host}/ws/ssh?${query.toString()}`
}
