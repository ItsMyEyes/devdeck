import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { ChevronDown, ChevronUp, MessageSquarePlus, X } from 'lucide-react'
import { inputFrame, resizeFrame, terminalWsUrl } from '@/lib/terminalClient'
import { createTerminalWriter } from '@/features/terminal/terminalWriter'
import { useResolvedTheme } from '@/features/theme/useTheme'
import type { Machine } from '@/store/types'

/** How long a connection must survive before its backoff counter is cleared.
 *  Resetting on `open` is wrong: the handshake is tiny and succeeds even on a
 *  link that then fails to carry the history replay, so a socket that opens
 *  and dies seconds later would pin the delay at its floor and reconnect in a
 *  tight loop — each attempt costing a fresh full replay. */
const CONNECTION_HEALTHY_MS = 10_000

/** Floor between manually-triggered reconnects (tab focus, `online` events),
 *  so a flapping network or rapid tab switching can't bypass the backoff by
 *  kicking a new attempt on every event. */
const MIN_KICK_INTERVAL_MS = 2_000

/** A captured xterm selection, addressed for the composer's terminal-context
 *  chip (`docs/superpowers/specs/2026-08-15-composer-context-attachments-design.md`,
 *  "C3 — terminal context"). `startLine`/`endLine` are 1-indexed — real line
 *  numbers a human would read off the screen, not xterm's internal 0-indexed
 *  buffer rows that `getSelectionPosition()` actually returns. */
export interface TerminalContextSelection {
  text: string
  sessionKey: string
  startLine: number
  endLine: number
}

export interface TerminalHandle {
  /** Write a line to the session's stdin (used by the "send input" box). */
  sendInput: (text: string) => void
  focus: () => void
  /** Serialize the full scrollback (including off-screen history) to the clipboard. */
  copyBuffer: () => void
  /** Captures the current selection for the composer's terminal-context chip.
   *  Returns `null` when there is no active (non-empty) selection. */
  captureSelection: () => TerminalContextSelection | null
}

/* xterm cannot read CSS custom properties, so the pane colour is duplicated
   here as a literal. It must track --devdeck-pane exactly: any drift shows up
   as a seam between the terminal canvas and the pane card behind it.
   The ANSI entries below are content, not chrome, and are left alone. */
export const TERMINAL_THEME = {
  background: '#1a1d1d',
  foreground: '#c9ccca',
  cursor: '#39c6bd',
  cursorAccent: '#1a1d1d',
  selectionBackground: '#39c6bd40',
  black: '#191a1c',
  red: '#f87171',
  green: '#56d58a',
  yellow: '#f5c451',
  blue: '#39c6bd',
  magenta: '#c7a3ff',
  cyan: '#8fd99f',
  white: '#d4d6d3',
  brightBlack: '#727575',
  brightRed: '#f08a8a',
  brightGreen: '#8fd99f',
  brightYellow: '#ffd66a',
  brightBlue: '#7fd9d3',
  brightMagenta: '#c7a3ff',
  brightCyan: '#8fd99f',
  brightWhite: '#eeeeeb',
}

/* Light counterpart. `background` tracks --devdeck-pane in `.light` for the
   same seam reason. The ANSI entries are NOT the dark ones lightened: on paper
   those wash out to illegibility (#56d58a green is 1.8:1 on white), so each
   keeps its hue and takes enough lightness contrast to stay readable as
   program output. */
export const TERMINAL_THEME_LIGHT = {
  background: '#f8faf9',
  foreground: '#1f2626',
  cursor: '#0e8a83',
  cursorAccent: '#f8faf9',
  selectionBackground: '#0e8a8340',
  black: '#24292e',
  red: '#c02626',
  green: '#217a3a',
  yellow: '#8a6413',
  blue: '#0e6fa8',
  magenta: '#8b3fc4',
  cyan: '#0e8a83',
  white: '#5c6363',
  brightBlack: '#6a7171',
  brightRed: '#d63a2f',
  brightGreen: '#2a8f47',
  brightYellow: '#9c7519',
  brightBlue: '#1580bd',
  brightMagenta: '#9c50d6',
  brightCyan: '#12a099',
  brightWhite: '#2b3232',
}

export function terminalTheme(resolved: 'light' | 'dark') {
  return resolved === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME
}

interface TerminalProps {
  session: string
  machine: Machine
  /** When true, the next single keystroke is sent as its Ctrl+key control code. */
  ctrlArmed?: boolean
  onCtrlConsumed?: () => void
  onExit?: () => void
  /** Called with the captured selection when the "Send to chat" affordance is
   *  clicked. This component has no notion of panes, threads, or which chat
   *  tab should receive it — resolving that (and inserting the chip) is the
   *  caller's job (`ExpandedTerminal.tsx`'s bridge). */
  onSendToChat?: (selection: TerminalContextSelection) => void
}

function isTerminalExitedFrame(data: string) {
  try {
    return (JSON.parse(data) as { t?: unknown }).t === 'x'
  } catch {
    return false
  }
}

/** Chords the app claims globally, which xterm must therefore not swallow.
 *
 *  Cmd/Ctrl+P without Alt/Shift is xterm's own binding for "send DLE (0x10) to
 *  the shell" — its keydown listener runs in the capture phase and calls
 *  `stopPropagation`, so the window-level quick-open shortcut in
 *  ExpandedTerminal.tsx/SSHShellPane.tsx never sees the keystroke while a
 *  terminal has focus. `attachCustomKeyEventHandler` returning `false` is
 *  xterm's documented way to let a key combo escape untouched instead.
 *
 *  Cmd/Ctrl+K joins it for the command palette (WorkspaceTileArea.tsx), which
 *  must open from anywhere — including a focused terminal. Nothing is lost:
 *  neither this file nor sshTerminalRegistry.ts ever bound Cmd+K to
 *  clear-screen. */
export function isAppShortcut(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false
  const key = event.key.toLowerCase()
  return key === 'p' || key === 'k'
}

/** xterm.js terminal wired to the devdeck WebSocket gateway for one session. */
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { session, machine, ctrlArmed = false, onCtrlConsumed, onExit, onSendToChat },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const outbox = useRef<string[]>([])
  const ctrlArmedRef = useRef(ctrlArmed)
  const onCtrlConsumedRef = useRef(onCtrlConsumed)
  const onExitRef = useRef(onExit)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const serializeAddonRef = useRef<SerializeAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // Driven by xterm's own `onSelectionChange` (`xterm.d.ts:996`), not derived
  // at render time — a selection is a fact about xterm's internal buffer,
  // and this is the only way to know it changed without polling.
  const [hasSelection, setHasSelection] = useState(false)

  // Held in a ref as well as read as state: the terminal is constructed once
  // per session and must not be torn down and rebuilt (losing the socket and
  // the scrollback) just because the palette changed, so creation reads the
  // ref and the effect below repaints the live instance in place.
  const resolvedTheme = useResolvedTheme()
  const themeRef = useRef(resolvedTheme)
  useEffect(() => {
    themeRef.current = resolvedTheme
    const term = termRef.current
    if (term) term.options.theme = terminalTheme(resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    ctrlArmedRef.current = ctrlArmed
  }, [ctrlArmed])
  useEffect(() => {
    onCtrlConsumedRef.current = onCtrlConsumed
  }, [onCtrlConsumed])
  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  function closeSearch() {
    setSearchOpen(false)
    termRef.current?.focus()
  }

  // Not inside the mount effect: it must always read `session` as of the
  // call, and the mount effect only reruns when `session`/`machine` change
  // (a stale closure there would ship the wrong sessionKey if other props
  // changed first). `termRef.current` is always current regardless.
  function captureSelection(): TerminalContextSelection | null {
    const term = termRef.current
    if (!term || !term.hasSelection()) return null
    const text = term.getSelection()
    const range = term.getSelectionPosition()
    if (!text || !range) return null
    return {
      text,
      sessionKey: session,
      // `IBufferRange` positions are 0-indexed buffer rows (verified against
      // the installed package at runtime — `xterm.d.ts`'s own "1-based" doc
      // comment does not match `getSelectionPosition()`'s actual output);
      // +1 turns them into the 1-indexed line numbers a human reads off the
      // screen, matching what the composer chip displays.
      startLine: range.start.y + 1,
      endLine: range.end.y + 1,
    }
  }

  useImperativeHandle(ref, () => ({
    sendInput: (text: string) => send(inputFrame(text)),
    focus: () => termRef.current?.focus(),
    copyBuffer: () => {
      const data = serializeAddonRef.current?.serialize()
      if (data) void navigator.clipboard.writeText(data)
    },
    captureSelection,
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
      theme: terminalTheme(themeRef.current),
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
    term.attachCustomKeyEventHandler((event) => !isAppShortcut(event))
    // WebGL addon loads AFTER `open()`, not before: xterm only activates a
    // renderer addon once the terminal is attached to the DOM, so loading it
    // first (the previous order here) deferred activation to xterm's own
    // internal renderer-swap timer — a macrotask outside this try/catch,
    // where a WebGL2-context failure (headless env, old GPU driver) becomes
    // an *uncaught* exception instead of the graceful fallback this comment
    // always claimed. Loading it after `open()` activates synchronously,
    // inside the try/catch, restoring the fallback this file's own doc
    // comment describes (verified: this is exactly the failure jsdom hits
    // building Terminal.test.tsx, and this reorder is what fixes it).
    term.open(host)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // WebGL unavailable (headless env, old GPU driver) — falls back to xterm's default renderer.
    }
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
    let healthyTimer: number | undefined
    let lastConnectAt = 0
    const writer = createTerminalWriter(term)
    // Set when reconnecting to a screen that already has content. The reset
    // happens together with the first frame of the new connection (which is
    // always the server's banner + history replay), so the stale screen stays
    // visible through the outage and repaints in a single frame — resetting
    // up front instead blanks the terminal for the whole backoff + replay
    // round-trip, which reads as a "refresh" on every mobile socket drop.
    let resetOnNextFrame = false
    let resolvedUrl: string | null = null
    let exited = false

    const handleExit = () => {
      if (exited || disposed) return
      exited = true
      onExitRef.current?.()
    }

    const clearHealthyTimer = () => {
      if (healthyTimer !== undefined) {
        window.clearTimeout(healthyTimer)
        healthyTimer = undefined
      }
    }

    const connect = () => {
      if (disposed || !resolvedUrl) return
      lastConnectAt = Date.now()
      const ws = new WebSocket(resolvedUrl)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        everOpened = true
        // Clear the backoff only once this connection has proven it can stay
        // up — see CONNECTION_HEALTHY_MS. Opening is not evidence of health.
        clearHealthyTimer()
        healthyTimer = window.setTimeout(() => {
          healthyTimer = undefined
          attempts = 0
        }, CONNECTION_HEALTHY_MS)
        // flush queued frames + sync current size
        ws.send(resizeFrame(term.cols, term.rows))
        for (const f of outbox.current) ws.send(f)
        outbox.current = []
      }
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string' && isTerminalExitedFrame(ev.data)) {
          handleExit()
          return
        }
        if (resetOnNextFrame) {
          resetOnNextFrame = false
          term.reset()
        }
        // Routed through the writer so a burst (a reattach replay, or a
        // runaway process) can't grow xterm's parse buffer without bound.
        if (typeof ev.data === 'string') writer.write(ev.data)
        else if (ev.data instanceof ArrayBuffer) writer.write(new Uint8Array(ev.data))
      }
      ws.onclose = (event) => {
        clearHealthyTimer()
        if (event.reason === 'terminal exited') handleExit()
        else if (!exited) scheduleReconnect()
      }
      ws.onerror = () => {
        if (!everOpened) {
          term.write('\r\n\x1b[38;5;210m[connection error - is the terminal server running?]\x1b[0m\r\n')
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
        term.write('\r\n\x1b[38;5;102m[connection lost - reconnecting…]\x1b[0m\r\n')
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
      // Jumping the pending backoff is for genuine "the situation changed"
      // moments. Rate-limit it so a flapping link or fast tab switching can't
      // turn every event into another attempt and defeat the backoff — each
      // attempt costs a full history replay on the wire. `attempts` is
      // deliberately not cleared here; only staying connected clears it.
      if (Date.now() - lastConnectAt < MIN_KICK_INTERVAL_MS) return
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer)
        retryTimer = undefined
      }
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
    // Drives the "Send to chat" affordance's visibility (`hasSelection`
    // state) — fires on every change, including to/from empty, so this is
    // also how the affordance disappears when the selection is cleared.
    const onSelectionChange = term.onSelectionChange(() => {
      setHasSelection(term.hasSelection())
    })

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
      writer.dispose()
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      if (healthyTimer !== undefined) window.clearTimeout(healthyTimer)
      if (fitTimer !== undefined) window.clearTimeout(fitTimer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', kick)
      window.removeEventListener('keydown', onFindShortcut)
      ro.disconnect()
      onData.dispose()
      onResize.dispose()
      onSelectionChange.dispose()
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
      // A session/machine change tears this terminal down and builds a new
      // one (see the effect's dep array) — the old selection doesn't carry
      // over, so the affordance shouldn't either.
      setHasSelection(false)
    }
  }, [session, machine])

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      {searchOpen ? (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md border border-devdeck-border bg-devdeck-pane px-2 py-1 shadow-lg">
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
            className="w-40 bg-transparent font-mono text-[11px] text-devdeck-fg outline-none"
          />
          <button
            type="button"
            onClick={() => searchAddonRef.current?.findPrevious(searchQuery)}
            aria-label="Previous match"
            className="cursor-pointer text-devdeck-fg-2 hover:text-devdeck-fg"
          >
            <ChevronUp size={12} />
          </button>
          <button
            type="button"
            onClick={() => searchAddonRef.current?.findNext(searchQuery)}
            aria-label="Next match"
            className="cursor-pointer text-devdeck-fg-2 hover:text-devdeck-fg"
          >
            <ChevronDown size={12} />
          </button>
          <button
            type="button"
            onClick={closeSearch}
            aria-label="Close search"
            className="cursor-pointer text-devdeck-fg-2 hover:text-devdeck-fg"
          >
            <X size={12} />
          </button>
        </div>
      ) : null}
      {hasSelection ? (
        <button
          type="button"
          onClick={() => {
            const selection = captureSelection()
            if (selection) onSendToChat?.(selection)
          }}
          className="absolute bottom-2 left-2 z-10 flex cursor-pointer items-center gap-1 rounded-md border border-devdeck-border bg-devdeck-pane px-2 py-1 text-[11px] text-devdeck-fg-2 shadow-lg hover:text-devdeck-fg"
        >
          <MessageSquarePlus size={12} />
          Send to chat
        </button>
      ) : null}
    </div>
  )
})
