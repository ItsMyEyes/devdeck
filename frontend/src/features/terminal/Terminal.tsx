import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { inputFrame, resizeFrame, terminalWsUrl } from '@/lib/terminalClient'

export interface TerminalHandle {
  /** Write a line to the session's stdin (used by the "send input" box). */
  sendInput: (text: string) => void
  focus: () => void
}

const THEME = {
  background: '#08090c',
  foreground: '#b6bcc6',
  cursor: '#6d8bff',
  cursorAccent: '#08090c',
  selectionBackground: '#2c355080',
  black: '#0c0d10',
  red: '#f87171',
  green: '#56d58a',
  yellow: '#f5c451',
  blue: '#6d8bff',
  magenta: '#c7a3ff',
  cyan: '#8fd99f',
  white: '#cdd2da',
  brightBlack: '#5f6672',
  brightRed: '#f08a8a',
  brightGreen: '#8fd99f',
  brightYellow: '#ffd66a',
  brightBlue: '#9db1ff',
  brightMagenta: '#c7a3ff',
  brightCyan: '#8fd99f',
  brightWhite: '#e8eaed',
}

interface TerminalProps {
  session: string
  /** When true, the next single keystroke is sent as its Ctrl+key control code. */
  ctrlArmed?: boolean
  onCtrlConsumed?: () => void
}

/** xterm.js terminal wired to the loom WebSocket gateway for one session. */
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { session, ctrlArmed = false, onCtrlConsumed },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const outbox = useRef<string[]>([])
  const ctrlArmedRef = useRef(ctrlArmed)
  const onCtrlConsumedRef = useRef(onCtrlConsumed)

  useEffect(() => {
    ctrlArmedRef.current = ctrlArmed
  }, [ctrlArmed])
  useEffect(() => {
    onCtrlConsumedRef.current = onCtrlConsumed
  }, [onCtrlConsumed])

  useImperativeHandle(ref, () => ({
    sendInput: (text: string) => send(inputFrame(text)),
    focus: () => termRef.current?.focus(),
  }))

  function send(frame: string) {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame)
    else outbox.current.push(frame)
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
      fontFamily: "'Geist Mono', ui-monospace, monospace",
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: true,
      convertEol: false,
      theme: THEME,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    fit.fit()
    termRef.current = term

    const cols = term.cols
    const rows = term.rows
    const ws = new WebSocket(terminalWsUrl(session, cols, rows))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      // flush queued frames + sync current size
      ws.send(resizeFrame(term.cols, term.rows))
      for (const f of outbox.current) ws.send(f)
      outbox.current = []
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') term.write(ev.data)
      else if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data))
    }
    ws.onclose = () => term.write('\r\n\x1b[38;5;102m[connection closed]\x1b[0m\r\n')
    ws.onerror = () => term.write('\r\n\x1b[38;5;210m[connection error — is the terminal server running?]\x1b[0m\r\n')

    const onData = term.onData((data) => {
      // Sticky Ctrl (armed from the mobile key toolbar): fold the next single
      // keystroke into its control code, e.g. "c" -> Ctrl+C (0x03).
      if (ctrlArmedRef.current && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0)
        if (code >= 64 && code <= 95) {
          send(inputFrame(String.fromCharCode(code - 64)))
          onCtrlConsumedRef.current?.()
          return
        }
      }
      send(inputFrame(data))
    })
    const onResize = term.onResize(({ cols, rows }) => send(resizeFrame(cols, rows)))

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* host detached */
      }
    })
    ro.observe(host)
    term.focus()

    return () => {
      ro.disconnect()
      onData.dispose()
      onResize.dispose()
      ws.onclose = null
      ws.onmessage = null
      ws.onerror = null
      ws.onopen = null
      ws.close()
      term.dispose()
      termRef.current = null
      wsRef.current = null
      // Drop any frames queued for a socket that never opened, so they can't be
      // flushed into a different session on the next connect.
      outbox.current = []
    }
  }, [session])

  return <div ref={hostRef} className="h-full w-full" />
})
