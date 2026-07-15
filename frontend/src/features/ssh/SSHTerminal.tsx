import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { inputFrame, resizeFrame } from '@/lib/terminalClient'
import { sshShellWsUrl } from '@/lib/sshClient'
import { TERMINAL_THEME } from '@/features/terminal/Terminal'

/** xterm.js wired to the hub's /ws/ssh gateway for one saved connection.
 *  Unlike the worktree Terminal there is no server-side reattach registry:
 *  the remote shell lives exactly as long as this socket, so a dropped
 *  connection is NOT silently retried (that would open a fresh shell and
 *  discard remote state without the user asking) — Enter reconnects. */
export function SSHTerminal({ connectionId }: { connectionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
      fontFamily: "'Geist Mono', ui-monospace, monospace",
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: true,
      convertEol: false,
      theme: TERMINAL_THEME,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    fit.fit()

    let disposed = false
    let ws: WebSocket | null = null

    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(sshShellWsUrl(connectionId, term.cols, term.rows))
      socket.binaryType = 'arraybuffer'
      ws = socket
      socket.onmessage = (ev) => {
        if (typeof ev.data === 'string') term.write(ev.data)
        else if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data))
      }
      socket.onclose = () => {
        if (disposed) return
        ws = null
        term.write('\r\n\x1b[38;5;102m[ssh session closed — press Enter to reconnect]\x1b[0m\r\n')
      }
      socket.onerror = () => {
        term.write('\r\n\x1b[38;5;210m[ssh connection error]\x1b[0m\r\n')
      }
    }

    connect()

    const onData = term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(inputFrame(data))
      } else if (!ws && data.includes('\r')) {
        // Enter on a dead session opens a fresh shell (no history replay —
        // the remote shell died with the previous socket).
        term.reset()
        connect()
      }
    })
    const onResize = term.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(resizeFrame(cols, rows))
    })

    // Trailing-edge debounce, mirroring Terminal.tsx: fold resize bursts
    // (mobile keyboard, divider drags) into a single fit + SIGWINCH.
    let fitTimer: number | undefined
    const ro = new ResizeObserver(() => {
      if (fitTimer !== undefined) window.clearTimeout(fitTimer)
      fitTimer = window.setTimeout(() => {
        fitTimer = undefined
        try {
          fit.fit()
        } catch {
          /* host detached */
        }
      }, 150)
    })
    ro.observe(host)
    term.focus()

    return () => {
      disposed = true
      if (fitTimer !== undefined) window.clearTimeout(fitTimer)
      ro.disconnect()
      onData.dispose()
      onResize.dispose()
      if (ws) {
        ws.onclose = null
        ws.onmessage = null
        ws.onerror = null
        ws.close()
      }
      term.dispose()
    }
  }, [connectionId])

  return <div ref={hostRef} className="h-full w-full" />
}
