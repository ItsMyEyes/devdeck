/**
 * Stateful wrapper around the `/ws/agent` WebSocket for one thread. Pairs
 * with `eventReducer.ts`'s pure `reduceAgentEvents` (folded through the
 * store's `applyAgentEvents`, so every open pane on the same `threadKey`
 * shares one view model) the same way `Terminal.tsx` pairs xterm with
 * `terminalClient.ts` — but the wire protocol here is a JSON envelope
 * (`{kind:'hello'|'command'|'events'|'error', ...}`), not raw bytes, so
 * reattach replays exactly instead of best-effort.
 *
 * Session lifetime mirrors the PTY contract: unmounting this hook (closing
 * the pane or the tab) only tears down the *socket*. The engine on the
 * runtime keeps consuming and persisting events regardless — reopening the
 * pane reconnects and replays from `lastSeq`, it does not resume a paused
 * turn.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { machineWsUrl } from '@/lib/machineClient'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { EMPTY_THREAD_VIEW } from '@/features/agent-chat/eventReducer'
import type { AgentEvent, AgentThreadView } from '@/features/agent-chat/types'
import type { Machine } from '@/store/types'

/** Connection status of the socket itself — distinct from
 *  `AgentThreadView.status` (the thread's idle/running/waiting/stopped,
 *  folded from the event log). The engine outlives the socket, so a thread
 *  can be `running` while its socket is `closed` mid-backoff. */
export type AgentSocketStatus = 'connecting' | 'open' | 'closed'

/** Mirrors `Terminal.tsx`'s reconnect tuning: only a connection that stays
 *  up for this long clears the backoff counter, so a handshake that opens
 *  and dies seconds later doesn't pin the delay at its floor. */
const CONNECTION_HEALTHY_MS = 10_000
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8_000

/** Mirrors `orchestration.Command` (`backend/internal/agentcore/orchestration/command.go`)
 *  — field names match its `json` tags exactly, one shape on both sides of
 *  the wire. Only the commands this hook issues are named here; the server
 *  rejects anything else a client tries to send via `ClientDispatchable`. */
type AgentCommandType = 'thread.turn.start' | 'thread.turn.interrupt' | 'thread.runtime-mode.set' | 'thread.interaction-mode.set'

/** Mirrors `provider.RuntimeMode` (`backend/internal/agentcore/provider/provider.go`)
 *  — string values match exactly, one enum on both sides of the wire. */
export type RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'

/** Mirrors `provider.InteractionMode`. */
export type InteractionMode = 'default' | 'plan'

interface AgentCommand {
  commandId: string
  type: AgentCommandType
  threadId: string
  issuedAt: number
  payload?: unknown
}

interface CommandFrame {
  kind: 'command'
  command: AgentCommand
}

interface HelloFrame {
  kind: 'hello'
  threadId: string
  sinceSeq: number
}

interface EventsFrame {
  kind: 'events'
  events: AgentEvent[]
}

interface ErrorFrame {
  kind: 'error'
  error: string
}

type ServerFrame = EventsFrame | ErrorFrame | { kind: string }

function isEventsFrame(frame: ServerFrame): frame is EventsFrame {
  return frame.kind === 'events' && Array.isArray((frame as EventsFrame).events)
}

function isErrorFrame(frame: ServerFrame): frame is ErrorFrame {
  return frame.kind === 'error' && typeof (frame as ErrorFrame).error === 'string'
}

export interface UseAgentChatSocketOptions {
  machine: Machine
  /** The backend's ThreadID verbatim — see `paneTree.ts`'s `AgentChatContent`. */
  threadKey: string
}

/** Mirrors the backend's `provider.ModelSelection` (see its json tags —
 *  those tags exist for this type). `instanceId` names the AGENT to run the
 *  turn on: leaving it unset keeps the worktree's configured agent, and
 *  setting it to a different one switches the thread over, which starts a
 *  fresh provider session (`Reactor.ensureSession`). */
export interface TurnModelSelection {
  instanceId?: string
  model?: string
  options?: Record<string, unknown>
}

export interface UseAgentChatSocketResult {
  view: AgentThreadView
  status: AgentSocketStatus
  /** Dispatches `thread.turn.start`. `model` rides the payload as the
   *  backend's `provider.ModelSelection`; omit it to let the worktree's own
   *  agent and its default model decide. Attachments are still to come. */
  sendTurn: (text: string, model?: TurnModelSelection) => void
  /** Dispatches `thread.turn.interrupt` for the thread's in-flight turn. */
  abortTurn: () => void
  /** Dispatches `thread.runtime-mode.set` — the composer's runtime-mode
   *  pill (`ComposerControls.tsx`). Fire-and-forget like `sendTurn`: a
   *  rejection comes back as an `error` frame, never a return value, so the
   *  pill that dispatched it is the one that decides how to revert. */
  setRuntimeMode: (mode: RuntimeMode) => void
  /** Dispatches `thread.interaction-mode.set` — the composer's
   *  interaction-mode pill (Build/Plan). */
  setInteractionMode: (mode: InteractionMode) => void
}

/** WS URL for one agent-chat thread, direct-first with hub-proxy fallback —
 *  same routing `terminalWsUrl`/`openLspTransport` use, no query params of
 *  its own since the protocol negotiates the thread over the `hello` frame
 *  rather than the URL.
 *
 *  The path is `/agent`, NOT `/ws/agent`: `machineWsUrl` already appends `/ws`
 *  to both the direct and proxy bases, so passing `/ws/agent` here produces
 *  `wss://host/ws/ws/agent` and every connection dies with a 400. Same
 *  convention as its two siblings — `terminalClient.ts` passes `/terminal`
 *  and `lspTransport.ts` passes `/lsp`, both reaching `/ws/...` on the
 *  runtime. */
export const AGENT_WS_PATH = '/agent'

function agentChatWsUrl(machine: Machine): Promise<string> {
  return machineWsUrl(machine, AGENT_WS_PATH, {})
}

export function useAgentChatSocket({ machine, threadKey }: UseAgentChatSocketOptions): UseAgentChatSocketResult {
  // Select the raw slot and fall back OUTSIDE the selector: returning a fresh
  // object from inside it re-renders forever (see EMPTY_THREAD_VIEW's comment).
  const storedView = useDevDeckStore((s) => s.agentThreads[threadKey])
  const view = storedView ?? EMPTY_THREAD_VIEW
  const applyAgentEvents = useDevDeckStore((s) => s.applyAgentEvents)
  const [status, setStatus] = useState<AgentSocketStatus>('connecting')
  /** Transport-level error (an `error` frame, or a socket that never opened)
   *  — kept separate from `view.error`, which `reduceAgentEvents` derives
   *  from the event log itself, and merged into the returned view below. */
  const [transportError, setTransportError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  /** Commands queued while the socket isn't open, flushed verbatim
   *  (same `commandId`) on the next `open` — this is what makes a
   *  reconnect-triggered resend idempotent instead of starting a second
   *  turn: the engine dedupes by `CommandID`, and this queue never mints a
   *  new one for the same user action. */
  const outboxRef = useRef<CommandFrame[]>([])

  useEffect(() => {
    let disposed = false
    let everOpened = false
    let attempts = 0
    let retryTimer: number | undefined
    let healthyTimer: number | undefined
    let resolvedUrl: string | null = null

    setStatus('connecting')
    outboxRef.current = []

    const clearHealthyTimer = () => {
      if (healthyTimer !== undefined) {
        window.clearTimeout(healthyTimer)
        healthyTimer = undefined
      }
    }

    const connect = () => {
      if (disposed || !resolvedUrl) return
      const ws = new WebSocket(resolvedUrl)
      wsRef.current = ws

      ws.onopen = () => {
        everOpened = true
        setStatus('open')
        setTransportError(null)
        // Clear the backoff only once this connection has proven it can stay
        // up — see CONNECTION_HEALTHY_MS. Opening is not evidence of health.
        clearHealthyTimer()
        healthyTimer = window.setTimeout(() => {
          healthyTimer = undefined
          attempts = 0
        }, CONNECTION_HEALTHY_MS)

        // sinceSeq is read fresh from the store at connect time (not a
        // value captured when this effect started), so a reconnect after
        // this pane already applied a batch of events replays only what's
        // still missing.
        const sinceSeq = useDevDeckStore.getState().agentThreads[threadKey]?.lastSeq ?? 0
        const hello: HelloFrame = { kind: 'hello', threadId: threadKey, sinceSeq }
        ws.send(JSON.stringify(hello))

        for (const frame of outboxRef.current) ws.send(JSON.stringify(frame))
        outboxRef.current = []
      }

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return
        let frame: ServerFrame
        try {
          frame = JSON.parse(ev.data) as ServerFrame
        } catch {
          return
        }
        if (isEventsFrame(frame)) {
          if (frame.events.length > 0) applyAgentEvents(threadKey, frame.events)
        } else if (isErrorFrame(frame)) {
          setTransportError(frame.error)
        }
      }

      ws.onclose = () => {
        clearHealthyTimer()
        wsRef.current = null
        if (!disposed) scheduleReconnect()
      }

      ws.onerror = () => {
        if (!everOpened) setTransportError('Could not connect to the agent chat socket')
      }
    }

    const scheduleReconnect = () => {
      if (disposed || retryTimer !== undefined) return
      setStatus('closed')
      const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS)
      attempts++
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined
        setStatus('connecting')
        connect()
      }, delay)
    }

    void agentChatWsUrl(machine).then((url) => {
      if (disposed) return
      resolvedUrl = url
      connect()
    })

    return () => {
      disposed = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      clearHealthyTimer()
      const ws = wsRef.current
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null
        ws.close()
      }
      wsRef.current = null
      outboxRef.current = []
    }
    // threadKey and machine identity are what a new socket connects to;
    // applyAgentEvents is a stable store action reference and deliberately
    // left out of the dependency array.
  }, [machine, threadKey])

  /** Sends `frame` if the socket is open, otherwise queues it for the next
   *  `open` — see `outboxRef`'s doc comment for why this is what keeps a
   *  retried command idempotent. */
  const dispatch = useCallback((type: AgentCommandType, payload?: unknown) => {
    const frame: CommandFrame = {
      kind: 'command',
      command: {
        commandId: crypto.randomUUID(),
        type,
        threadId: threadKey,
        issuedAt: Date.now(),
        payload,
      },
    }
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame))
    } else {
      outboxRef.current.push(frame)
    }
  }, [threadKey])

  // `model` is omitted entirely when unset rather than sent as `{}`: an empty
  // InstanceID means "whatever this worktree is configured for" on the
  // backend, and sending the key at all would be indistinguishable from a
  // deliberate blank.
  const sendTurn = useCallback(
    (text: string, model?: TurnModelSelection) => dispatch('thread.turn.start', model ? { text, model } : { text }),
    [dispatch],
  )
  const abortTurn = useCallback(() => dispatch('thread.turn.interrupt'), [dispatch])
  const setRuntimeMode = useCallback((mode: RuntimeMode) => dispatch('thread.runtime-mode.set', { mode }), [dispatch])
  const setInteractionMode = useCallback((mode: InteractionMode) => dispatch('thread.interaction-mode.set', { mode }), [dispatch])

  const mergedView: AgentThreadView = transportError ? { ...view, error: transportError } : view

  return { view: mergedView, status, sendTurn, abortTurn, setRuntimeMode, setInteractionMode }
}
