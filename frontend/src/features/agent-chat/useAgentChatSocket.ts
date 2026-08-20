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
import type { AgentAttachmentRef } from '@/features/agent-chat/ComposerAttachments'
import { EMPTY_THREAD_VIEW } from '@/features/agent-chat/eventReducer'
import type { AgentEvent, AgentThreadView } from '@/features/agent-chat/types'
import type { Machine } from '@/store/types'

/** Connection status of the socket itself — distinct from
 *  `AgentThreadView.status` (the thread's idle/running/waiting/stopped,
 *  folded from the event log). The engine outlives the socket, so a thread
 *  can be `running` while its socket is `closed` mid-backoff.
 *
 *  `'draft'` means `connect: false` — no socket has ever been opened for
 *  this thread and none will be until the caller flips the gate. It is a
 *  socket status, not a thread status: `AgentThreadView.status` has no
 *  opinion about a thread that doesn't exist on the server yet (spec
 *  `2026-08-15-composer-drafts-and-stash-design.md` §7). */
/** `'unreachable'` is `'closed'` that has given up pretending.
 *
 *  The socket still retries underneath it — the state is a reporting change,
 *  not a lifecycle one, so a runtime that comes back still reconnects on its
 *  own. What changes is what the operator is told. `'connecting'`/`'closed'`
 *  carry a deliberately reassuring banner ("the agent keeps working while you
 *  are disconnected"), which is true of a brief blip and a lie about a socket
 *  that has never once opened. Without this the pane sat on "Connecting…"
 *  forever against a runtime that was never going to answer. */
export type AgentSocketStatus = 'draft' | 'connecting' | 'open' | 'closed' | 'unreachable'

/** Mirrors `Terminal.tsx`'s reconnect tuning: only a connection that stays
 *  up for this long clears the backoff counter, so a handshake that opens
 *  and dies seconds later doesn't pin the delay at its floor. */
const CONNECTION_HEALTHY_MS = 10_000
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8_000

/** Consecutive failed attempts, with the socket never once having opened,
 *  before the status flips to `'unreachable'`.
 *
 *  Four is where the backoff schedule (0.5s, 1s, 2s, 4s) has spent ~7.5s —
 *  long enough that a runtime restart or a slow tunnel has had a fair chance,
 *  short enough that an operator staring at a dead pane is not lied to for a
 *  minute. Deliberately gated on "never opened": a socket that worked and then
 *  dropped is genuinely reconnecting, and its reassuring banner is honest. */
const UNREACHABLE_AFTER_ATTEMPTS = 4

/** Mirrors `orchestration.Command` (`backend/internal/agentcore/orchestration/command.go`)
 *  — field names match its `json` tags exactly, one shape on both sides of
 *  the wire. Only the commands this hook issues are named here; the server
 *  rejects anything else a client tries to send via `ClientDispatchable`. */
type AgentCommandType =
  | 'thread.turn.start'
  | 'thread.turn.interrupt'
  | 'thread.runtime-mode.set'
  | 'thread.interaction-mode.set'
  | 'thread.user-input.respond'
  | 'thread.approval.respond'

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

/** Names this thread's backend explicitly instead of handing over a bare
 *  `Machine` the caller may not have — an SSH thread (spec
 *  `2026-08-17-ssh-devops-chat-design.md` §3.3) has no worktree and
 *  therefore no runtime `Machine` at all, since it runs on the hub itself.
 *
 *  - `'machine'` — a worktree thread. Its socket dials the named machine's
 *    runtime, same as every thread before this type existed.
 *  - `'hub'` — an SSH thread. Its socket dials the hub process directly —
 *    see `agentChatWsUrl`'s doc comment for why there is no machine to
 *    resolve here. */
export type AgentChatTarget = { kind: 'machine'; machine: Machine } | { kind: 'hub' }

export interface UseAgentChatSocketOptions {
  target: AgentChatTarget
  /** The backend's ThreadID verbatim — see `paneTree.ts`'s `AgentChatContent`. */
  threadKey: string
  /** `false` gates the socket entirely: no `WebSocket` is constructed, no
   *  hello is sent, and no thread row is created on the server (the socket
   *  hello is what lazily creates it, `handler/agent_ws.go:129-141`).
   *  Defaults to `true` — every existing call site keeps today's behaviour
   *  unchanged. Commands issued while `false` still queue in `outboxRef` and
   *  flush once the gate flips and the socket opens; see the connect
   *  effect's own comment for why the outbox reset must NOT key on this. */
  connect?: boolean
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
   *  agent and its default model decide. `attachments` mirrors
   *  `provider.Attachment`'s JSON tags exactly (`id`/`kind`/`mime`/`name`,
   *  no raw bytes — see `ComposerAttachments.tsx`'s doc comment on why) and
   *  is omitted from the wire payload entirely when empty, the same
   *  precedent `model` already sets below. */
  sendTurn: (text: string, model?: TurnModelSelection, attachments?: AgentAttachmentRef[]) => void
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
  /** Dispatches `thread.user-input.respond` — already on the server's
   *  `ClientDispatchable` allowlist (`command.go:56`), no backend
   *  authorization change needed. */
  respondToUserInput: (requestId: string, answers: Record<string, unknown>) => void
  /** Dispatches `thread.approval.respond` — already on `ClientDispatchable`
   *  (`command.go:55`). `decision` is one of `event.Decision`'s wire values. */
  respondToApproval: (requestId: string, decision: string) => void
  /** Clears the transport-level `view.error` (`setTransportError(null)`) —
   *  the composer banner stack's F2 dismissal (spec
   *  `2026-08-15-composer-banner-stack-design.md`, Design §4). `view.error`
   *  is transport-only (see this file's `transportError` doc comment above);
   *  it never touches the thread's event-derived state.
   *
   *  Safe to widen: `usePillState` (`ComposerControls.tsx:227-237`) is the
   *  only other reader of `view.error`, and its effect is a no-op when
   *  `error` is `null` (`if (error !== null && pending !== null)`), so
   *  driving `error` to `null` here cannot spuriously revert a pending
   *  pill. */
  clearError: () => void
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

/** Resolves `target` (see `AgentChatTarget`'s doc comment) to the actual
 *  `/ws/agent` URL to open.
 *
 *  - `'machine'` keeps calling `machineWsUrl` exactly as before — see
 *    `AGENT_WS_PATH`'s comment above for the `/agent`-not-`/ws/agent` trap
 *    that still applies to this branch.
 *  - `'hub'` builds the URL the same way `sshClient.ts`'s `sshShellWsUrl`
 *    builds `/ws/ssh`: the page's own origin, no machine resolution, no
 *    direct/proxy fallback. SSH threads run on the hub process itself — the
 *    SSH connection pool and its credentials never leave it (design spec
 *    §3.2) — so there is nothing else to dial. */
export function agentChatWsUrl(target: AgentChatTarget): Promise<string> {
  if (target.kind === 'hub') {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return Promise.resolve(`${proto}://${window.location.host}/ws/agent`)
  }
  return machineWsUrl(target.machine, AGENT_WS_PATH, {})
}

export function useAgentChatSocket({ target, threadKey, connect = true }: UseAgentChatSocketOptions): UseAgentChatSocketResult {
  // Select the raw slot and fall back OUTSIDE the selector: returning a fresh
  // object from inside it re-renders forever (see EMPTY_THREAD_VIEW's comment).
  const storedView = useDevDeckStore((s) => s.agentThreads[threadKey])
  const view = storedView ?? EMPTY_THREAD_VIEW
  const applyAgentEvents = useDevDeckStore((s) => s.applyAgentEvents)
  const [status, setStatus] = useState<AgentSocketStatus>(connect ? 'connecting' : 'draft')
  /** Transport-level error (an `error` frame, or a socket that never opened)
   *  — kept separate from `view.error`, which `reduceAgentEvents` derives
   *  from the event log itself, and merged into the returned view below. */
  const [transportError, setTransportError] = useState<string | null>(null)
  /** `lastSeq` at the moment Stop was pressed, or null.
   *
   *  Stop is a request over the socket, and the whole point of this goal is
   *  that it used to be possible for nothing to answer it — a dead CLI, a
   *  closed socket (the frame only reaches `outboxRef`), a provider that
   *  ignores the interrupt. The thread then sat on `running` with Stop as its
   *  only control and Stop doing nothing.
   *
   *  So the UI leaves `running` immediately and lets the server correct it:
   *  the override is scoped to "no event has arrived since", so the first
   *  event the backend does send — including the status it settles on — wins
   *  automatically. It expires itself; nothing has to remember to clear it. */
  const [abortedAtSeq, setAbortedAtSeq] = useState<number | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  /** Commands queued while the socket isn't open, flushed verbatim
   *  (same `commandId`) on the next `open` — this is what makes a
   *  reconnect-triggered resend idempotent instead of starting a second
   *  turn: the engine dedupes by `CommandID`, and this queue never mints a
   *  new one for the same user action. */
  const outboxRef = useRef<CommandFrame[]>([])

  /** Stable identity for the two effects below — deliberately narrower than
   *  `target` itself. A caller typically builds `target={{ kind: 'machine',
   *  machine }}` (or `{ kind: 'hub' }`) as a fresh object literal on every
   *  render, so depending on `target` directly would tear the socket down
   *  and reopen it on every unrelated re-render of the caller. `'hub'` has
   *  one fixed identity (every SSH thread dials the same origin); the
   *  `'machine'` variant keys off the `Machine` object itself, which — like
   *  the bare `machine` option this replaces — only changes reference when
   *  the machine's own data changes (TanStack Query's structural sharing). */
  const targetIdentity: Machine | 'hub' = target.kind === 'hub' ? 'hub' : target.machine

  /** Owns the outbox reset, and *only* the reset — keyed on thread identity
   *  alone, not `connect`. A `connect` flip from `false` to `true` is the
   *  outbox's reason to exist (a queued turn is what triggers the flip in
   *  `AgentChatPane`); a `target`/`threadKey` change is a genuinely
   *  different thread, where replaying a stale queued command really would
   *  be wrong. See the connect effect below for the trap this avoids. */
  useEffect(() => {
    outboxRef.current = []
  }, [targetIdentity, threadKey])

  useEffect(() => {
    // A draft thread opens no socket, sends no hello, and creates no row on
    // the server (the hello is what lazily creates it). The outbox is
    // untouched here — see the effect above — so a command queued while
    // `connect` is `false` survives the flip to `true`.
    if (!connect) {
      setStatus('draft')
      return
    }

    let disposed = false
    let everOpened = false
    let attempts = 0
    let retryTimer: number | undefined
    let healthyTimer: number | undefined
    let resolvedUrl: string | null = null

    setStatus('connecting')

    const clearHealthyTimer = () => {
      if (healthyTimer !== undefined) {
        window.clearTimeout(healthyTimer)
        healthyTimer = undefined
      }
    }

    const openSocket = () => {
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
      // Retrying either way — only the reported state differs. See
      // AgentSocketStatus' doc comment for why a never-opened socket must stop
      // claiming it is merely "connecting".
      const givenUp = !everOpened && attempts >= UNREACHABLE_AFTER_ATTEMPTS
      setStatus(givenUp ? 'unreachable' : 'closed')
      const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS)
      attempts++
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined
        // Once given up, stay given up until something actually opens —
        // flipping back to 'connecting' on every retry would restore the
        // endless "Connecting…" banner one frame at a time.
        if (!givenUp) setStatus('connecting')
        openSocket()
      }, delay)
    }

    void agentChatWsUrl(target).then((url) => {
      if (disposed) return
      resolvedUrl = url
      openSocket()
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
      // Deliberately does NOT touch outboxRef — see this effect's own doc
      // comment and the sibling effect above. Clearing it here was the
      // outbox trap: a `connect` flip unmounts this run's closure, and
      // wiping the queue on that transition would silently drop the very
      // command that caused the flip.
    }
    // threadKey and targetIdentity are what a new socket connects to; connect
    // is the draft gate; applyAgentEvents is a stable store action reference
    // and deliberately left out of the dependency array. `target` itself is
    // also deliberately excluded — see `targetIdentity`'s doc comment above
    // for why depending on the wrapper object would reconnect on every
    // unrelated render of the caller; the `agentChatWsUrl(target)` call
    // above still gets a fresh `target` every render, it just doesn't retrigger
    // this effect on its own.
  }, [targetIdentity, threadKey, connect])

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
  // deliberate blank. `attachments` follows the same precedent — an empty
  // array is indistinguishable from "no attachments" on the wire, so it is
  // omitted rather than sent as `[]`.
  const sendTurn = useCallback(
    (text: string, model?: TurnModelSelection, attachments?: AgentAttachmentRef[]) => {
      // Drop a still-live abort override, or a turn sent while the backend is
      // unreachable would render as idle until its first event lands.
      setAbortedAtSeq(null)
      dispatch('thread.turn.start', {
        text,
        ...(model ? { model } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      })
    },
    [dispatch],
  )
  const abortTurn = useCallback(() => {
    dispatch('thread.turn.interrupt')
    setAbortedAtSeq(view.lastSeq)
  }, [dispatch, view.lastSeq])
  const setRuntimeMode = useCallback((mode: RuntimeMode) => dispatch('thread.runtime-mode.set', { mode }), [dispatch])
  const setInteractionMode = useCallback((mode: InteractionMode) => dispatch('thread.interaction-mode.set', { mode }), [dispatch])
  const respondToUserInput = useCallback(
    (requestId: string, answers: Record<string, unknown>) => dispatch('thread.user-input.respond', { requestId, answers }),
    [dispatch],
  )
  const respondToApproval = useCallback(
    (requestId: string, decision: string) => dispatch('thread.approval.respond', { requestId, decision }),
    [dispatch],
  )
  const clearError = useCallback(() => setTransportError(null), [])

  // Held only until the backend says otherwise — see `abortedAtSeq`.
  const abortPending = abortedAtSeq !== null && view.lastSeq <= abortedAtSeq && view.status === 'running'
  const mergedView: AgentThreadView =
    transportError || abortPending
      ? { ...view, ...(transportError ? { error: transportError } : {}), ...(abortPending ? { status: 'idle' as const } : {}) }
      : view

  return {
    view: mergedView,
    status,
    sendTurn,
    abortTurn,
    setRuntimeMode,
    setInteractionMode,
    respondToUserInput,
    respondToApproval,
    clearError,
  }
}
