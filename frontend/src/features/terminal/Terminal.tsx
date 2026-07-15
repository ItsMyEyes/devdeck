import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { inputFrame, resizeFrame, terminalWsUrl } from '@/lib/terminalClient'
import type { Machine } from '@/store/types'

export interface TerminalHandle {
  /** Write a line to the session's stdin (used by the "send input" box). */
  sendInput: (text: string) => void
  focus: () => void
  /** Serialize the full scrollback (including off-screen history) to the clipboard. */
  copyBuffer: () => void
}

export const TERMINAL_THEME = {
  background: '#111214',
  foreground: '#c9ccca',
  cursor: '#39c6bd',
  cursorAccent: '#111214',
  selectionBackground: '#315b5980',
  black: '#191a1c',
  red: '#f87171',
  green: '#56d58a',
  yellow: '#f5c451',
  blue: '#39c6bd',
  magenta: '#c7a3ff',
  cyan: '#8fd99f',
  white: '#d4d6d3',
  brightBlack: '#686e73',
  brightRed: '#f08a8a',
  brightGreen: '#8fd99f',
  brightYellow: '#ffd66a',
  brightBlue: '#7fd9d3',
  brightMagenta: '#c7a3ff',
  brightCyan: '#8fd99f',
  brightWhite: '#eeeeeb',
}

interface TerminalProps {
  session: string
  machine: Machine
  /** When true, the next single keystroke is sent as its Ctrl+key control code. */
  ctrlArmed?: boolean
  onCtrlConsumed?: () => void
}

/** xterm.js terminal wired to the loom WebSocket gateway for one session. */
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { session, machine, ctrlArmed = false, onCtrlConsumed },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const outbox = useRef<string[]>([])
  const ctrlArmedRef = useRef(ctrlArmed)
  const onCtrlConsumedRef = useRef(onCtrlConsumed)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const serializeAddonRef = useRef<SerializeAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    ctrlArmedRef.current = ctrlArmed
  }, [ctrlArmed])
  useEffect(() => {
    onCtrlConsumedRef.current = onCtrlConsumed
  }, [onCtrlConsumed])
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  function closeSearch() {
    setSearchOpen(false)
    termRef.current?.focus()
  }

  useImperativeHandle(ref, () => ({
    sendInput: (text: string) => send(inputFrame(text)),
    focus: () => termRef.current?.focus(),
    copyBuffer: () => {
      const data = serializeAddonRef.current?.serialize()
      if (data) void navigator.clipboard.writeText(data)
    },
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
      theme: TERMINAL_THEME,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    const serialize = new SerializeAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(search)
    term.loadAddon(serialize)
    searchAddonRef.current = search
    serializeAddonRef.current = serialize
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // WebGL unavailable (headless env, old GPU driver) — falls back to xterm's default renderer.
    }
    term.open(host)
    fit.fit()
    termRef.current = term

    // The session's PTY survives disconnects server-side (grace period +
    // history replay on reattach), so any close we didn't initiate is treated
    // as transient and reconnected with backoff. Mobile browsers drop sockets
    // constantly (tab freeze on app switch / screen lock, Wi-Fi <-> cellular
    // handoff) — without this the terminal dies on the first hiccup.
    let disposed = false
    let everOpened = false
    let attempts = 0
    let retryTimer: number | undefined
    // Set when reconnecting to a screen that already has content. The reset
    // happens together with the first frame of the new connection (which is
    // always the server's banner + history replay), so the stale screen stays
    // visible through the outage and repaints in a single frame — resetting
    // up front instead blanks the terminal for the whole backoff + replay
    // round-trip, which reads as a "refresh" on every mobile socket drop.
    let resetOnNextFrame = false
    let resolvedUrl: string | null = null

    const connect = () => {
      if (disposed || !resolvedUrl) return
      const ws = new WebSocket(resolvedUrl)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        everOpened = true
        attempts = 0
        // flush queued frames + sync current size
        ws.send(resizeFrame(term.cols, term.rows))
        for (const f of outbox.current) ws.send(f)
        outbox.current = []
      }
      ws.onmessage = (ev) => {
        if (resetOnNextFrame) {
          resetOnNextFrame = false
          term.reset()
        }
        if (typeof ev.data === 'string') term.write(ev.data)
        else if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data))
      }
      ws.onclose = () => scheduleReconnect()
      ws.onerror = () => {
        if (!everOpened) {
          term.write('\r\n\x1b[38;5;210m[connection error — is the terminal server running?]\x1b[0m\r\n')
        }
      }
    }

    const scheduleReconnect = () => {
      if (disposed || retryTimer !== undefined) return
      const delay = Math.min(500 * 2 ** attempts, 8000)
      // A single quick blip (cell tower handoff, brief Wi-Fi drop) recovers on
      // the first retry and doesn't need to alarm the user; only surface the
      // message once a retry has already failed, i.e. the drop is sustained.
      if (attempts > 0) {
        term.write('\r\n\x1b[38;5;102m[connection lost — reconnecting…]\x1b[0m\r\n')
      }
      attempts++
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined
        // The server replays banner + buffered history on reattach; reset
        // when it arrives so the replay doesn't duplicate what's on screen.
        resetOnNextFrame = true
        connect()
      }, delay)
    }

    // Reconnect immediately when the tab returns to the foreground or the
    // network comes back, instead of waiting out the backoff timer.
    const kick = () => {
      if (disposed) return
      const ws = wsRef.current
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        // A socket that survived a tab freeze may claim OPEN while the peer
        // is long gone; a no-op frame forces the dead TCP path to surface as
        // a close event, which reconnects via scheduleReconnect.
        if (ws.readyState === WebSocket.OPEN) ws.send(resizeFrame(term.cols, term.rows))
        return
      }
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer)
        retryTimer = undefined
      }
      attempts = 0
      resetOnNextFrame = true
      connect()
    }
    const onVisible = () => {
      if (!document.hidden) kick()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', kick)

    // Browsers reserve Cmd/Ctrl+F for their own find bar; intercept it while
    // the terminal is focused so it opens the addon-search bar instead.
    const onFindShortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && host.contains(e.target as Node)) {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onFindShortcut)

    void terminalWsUrl(machine, session, term.cols, term.rows).then((url) => {
      if (disposed) return
      resolvedUrl = url
      connect()
    })

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

    // Debounced: a mobile keyboard opening (or the visual viewport jittering
    // while it animates) resizes the host many times over ~300ms, and every
    // fit() that changes rows reflows xterm and SIGWINCHes the shell — a
    // visible repaint storm right as the user starts typing. Trailing-edge
    // debounce folds the burst into a single resize.
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
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      if (fitTimer !== undefined) window.clearTimeout(fitTimer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', kick)
      window.removeEventListener('keydown', onFindShortcut)
      ro.disconnect()
      onData.dispose()
      onResize.dispose()
      const ws = wsRef.current
      if (ws) {
        ws.onclose = null
        ws.onmessage = null
        ws.onerror = null
        ws.onopen = null
        ws.close()
      }
      term.dispose()
      termRef.current = null
      wsRef.current = null
      // Drop any frames queued for a socket that never opened, so they can't be
      // flushed into a different session on the next connect.
      outbox.current = []
    }
  }, [session, machine])

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      {searchOpen ? (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md border border-loom-border bg-loom-surface px-2 py-1 shadow-lg">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (e.shiftKey) searchAddonRef.current?.findPrevious(searchQuery)
                else searchAddonRef.current?.findNext(searchQuery)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeSearch()
              }
            }}
            placeholder="Find…"
            className="w-40 bg-transparent font-mono text-[11px] text-loom-fg outline-none"
          />
          <button
            type="button"
            onClick={() => searchAddonRef.current?.findPrevious(searchQuery)}
            aria-label="Previous match"
            className="cursor-pointer text-loom-muted hover:text-loom-fg"
          >
            <ChevronUp size={12} />
          </button>
          <button
            type="button"
            onClick={() => searchAddonRef.current?.findNext(searchQuery)}
            aria-label="Next match"
            className="cursor-pointer text-loom-muted hover:text-loom-fg"
          >
            <ChevronDown size={12} />
          </button>
          <button
            type="button"
            onClick={closeSearch}
            aria-label="Close search"
            className="cursor-pointer text-loom-muted hover:text-loom-fg"
          >
            <X size={12} />
          </button>
        </div>
      ) : null}
    </div>
  )
})
