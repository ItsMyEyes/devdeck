import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { inputFrame, resizeFrame } from '@/lib/terminalClient'
import { sshShellWsUrl } from '@/lib/sshClient'
import { isAppShortcut, TERMINAL_THEME } from '@/features/terminal/Terminal'
import { createTerminalWriter, type TerminalWriter } from '@/features/terminal/terminalWriter'

/**
 * Module-level (not React-owned) registry of live SSH shell sessions, keyed
 * by the pane content's stable `sessionKey`. `SSHShellPane`'s `PaneCanvas`
 * remounts the leaf that hosts a terminal on every drag-to-split/merge move
 * (`moveTab` always allocates a fresh leaf id — see paneTree.ts), which is
 * harmless for the worktree Terminal (server-side PTY reattach + history
 * replay hides the blip) but fatal here: per sshmgr.Server.HandleWS's own
 * doc comment, an SSH shell's lifetime IS its socket's lifetime, so a
 * remount-triggered reconnect silently kills the remote shell. Keeping the
 * `XTerm`/`WebSocket` pair alive here, outside the component tree, means a
 * pure pane-tree restructure (a view change) never touches the connection —
 * `SSHTerminal` just reparents the same `term.element` into its new host.
 */
interface SSHSession {
  term: XTerm
  fit: FitAddon
  ws: WebSocket | null
  /** Bounds how much unparsed output is held for `term` — a remote command
   *  producing more than the renderer can keep up with otherwise grows
   *  xterm's internal buffer without limit. See terminalWriter.ts. */
  writer: TerminalWriter
}

const sessions = new Map<string, SSHSession>()

function connect(session: SSHSession, connectionId: string) {
  const { term } = session
  const socket = new WebSocket(sshShellWsUrl(connectionId, term.cols, term.rows))
  socket.binaryType = 'arraybuffer'
  session.ws = socket
  socket.onmessage = (ev) => {
    if (typeof ev.data === 'string') session.writer.write(ev.data)
    else if (ev.data instanceof ArrayBuffer) session.writer.write(new Uint8Array(ev.data))
  }
  socket.onclose = () => {
    if (session.ws !== socket) return
    session.ws = null
    term.write('\r\n\x1b[38;5;102m[ssh session closed - press Enter to reconnect]\x1b[0m\r\n')
  }
  socket.onerror = () => {
    term.write('\r\n\x1b[38;5;210m[ssh connection error]\x1b[0m\r\n')
  }
}

function createSession(connectionId: string): SSHSession {
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
  // See Terminal.tsx's isAppShortcut doc comment: without this, Ctrl/Cmd+P
  // never reaches SSHShellPane's window-level quick-open shortcut while the
  // terminal has focus — xterm swallows it as its own "send DLE" binding.
  // Ctrl/Cmd+K rides the same escape hatch so the command palette opens from
  // inside an SSH shell too.
  term.attachCustomKeyEventHandler((event) => !isAppShortcut(event))

  const session: SSHSession = { term, fit, ws: null, writer: createTerminalWriter(term) }

  term.onData((data) => {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(inputFrame(data))
    } else if (!session.ws && data.includes('\r')) {
      // Enter on a dead session opens a fresh shell (no history replay —
      // the remote shell died with the previous socket).
      term.reset()
      connect(session, connectionId)
    }
  })
  term.onResize(({ cols, rows }) => {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(resizeFrame(cols, rows))
  })

  connect(session, connectionId)
  return session
}

/** Returns the live session for `sessionKey`, creating (and connecting) one
 *  on first use. Either way, `term.element` ends up attached under `host` —
 *  a fresh `term.open(host)` the first time, a plain DOM reparent (state and
 *  socket untouched) on every later call for the same key. `refit` lets the
 *  caller re-run the fit addon later (e.g. on host resize) without repeating
 *  the reparent check. */
export function attachSSHSession(
  sessionKey: string,
  connectionId: string,
  host: HTMLElement,
): { term: XTerm; refit: () => void } {
  let session = sessions.get(sessionKey)
  if (!session) {
    session = createSession(connectionId)
    sessions.set(sessionKey, session)
    session.term.open(host)
  } else if (session.term.element && session.term.element.parentElement !== host) {
    host.appendChild(session.term.element)
  }
  session.fit.fit()
  return { term: session.term, refit: () => session.fit.fit() }
}

/** Tears down the session for real — only call this when the terminal tab
 *  itself is closing (not for a pane-tree restructure), e.g. from
 *  `handleCloseTab`/`handleClosePane`, or when the whole SSH shell tab
 *  unmounts (see `collectTerminalSessionKeys`). */
export function disposeSSHSession(sessionKey: string) {
  const session = sessions.get(sessionKey)
  if (!session) return
  sessions.delete(sessionKey)
  session.writer.dispose()
  if (session.ws) {
    session.ws.onclose = null
    session.ws.onmessage = null
    session.ws.onerror = null
    session.ws.close()
  }
  session.term.dispose()
}
