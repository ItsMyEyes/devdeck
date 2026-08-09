/**
 * Pure `Event[]` -> view-model reducer for one agent thread. No React, no
 * WebSocket — see `useAgentChatSocket.ts` for the stateful wrapper that
 * feeds this. Mirrors `orchestration.Apply` on the backend in spirit: it
 * folds an ordered event log into a read model, and it must be safe to
 * re-apply an overlapping tail after a reconnect-and-replay.
 */
import type { AgentEvent, AgentThreadView, ChatItem, ChatItemKind } from '@/features/agent-chat/types'

export function emptyThreadView(): AgentThreadView {
  return {
    items: [],
    status: 'idle',
    lastSeq: 0,
    hasGap: false,
    error: null,
  }
}

/** The stable, shared empty view — use this (never a fresh `emptyThreadView()`)
 *  as the fallback inside a zustand selector.
 *
 *  zustand compares a selector's result with `Object.is`, so a selector like
 *  `(s) => s.agentThreads[key] ?? emptyThreadView()` returns a brand-new object
 *  on every store read while the thread is absent, which reads as "changed"
 *  every time and re-renders forever (React error #185, "Maximum update depth
 *  exceeded"). That fires on *every* mount of a thread that has no events yet,
 *  which is the normal case for a freshly opened chat pane.
 *
 *  Safe to share because `reduceAgentEvents` is pure — it always returns a new
 *  object and never mutates the view it is given. */
export const EMPTY_THREAD_VIEW: AgentThreadView = Object.freeze(emptyThreadView())

/** An assistant/reasoning text delta — `AssistantDeltaPayload` on the wire. */
interface ActivityAppendedPayload {
  itemId: string
  stream: string
  text: string
  sequence: number
}

function isActivityAppendedPayload(payload: unknown): payload is ActivityAppendedPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  return typeof p.itemId === 'string' && typeof p.stream === 'string' && typeof p.text === 'string' && typeof p.sequence === 'number'
}

/** The user's own message — `TurnStartPayload` carried by
 *  `thread.message-sent`. Rendering this is what makes a sent message appear
 *  at all; the assistant's reply arrives later and separately. */
interface MessageSentPayload {
  text: string
}

function isMessageSentPayload(payload: unknown): payload is MessageSentPayload {
  if (typeof payload !== 'object' || payload === null) return false
  return typeof (payload as Record<string, unknown>).text === 'string'
}

/** A canonical provider event forwarded verbatim by Ingestion's fallback
 *  ("better to store an unrecognized event as activity than drop it"), so the
 *  activity-appended payload is a whole `event.Event` envelope rather than a
 *  delta. Tool calls arrive exclusively this way — `item.started` /
 *  `item.completed` with an `itemType` of `tool_call`. */
interface ForwardedProviderEvent {
  type: string
  itemId?: string
  payload?: {
    itemType?: string
    title?: string
    status?: string
    message?: string
    /** `ItemStartedPayload.Detail` / `ItemCompletedPayload.Detail` — an opaque
     *  `json.RawMessage` on the wire. On `item.started` it is
     *  `{toolCallId, name}`; on `item.completed` it is the tool's own input
     *  JSON. Never interpreted here beyond picking out `toolCallId`. */
    detail?: unknown
  }
}

/** `thread.session-set`'s payload — Ingestion dispatches `CmdThreadSessionSet`
 *  with `{status}` for SessionStarted (running), TurnCompleted/TurnAborted
 *  (idle), SessionExited (stopped) and RequestOpened/UserInputRequested
 *  (waiting), sometimes alongside a `resumeCursor` or a `pendingRequestAdd`.
 *  Mirrors `applyOne`'s `EvtThreadSessionSet` case: an absent or unrecognised
 *  status leaves the thread's current status alone. */
const THREAD_STATUSES: readonly AgentThreadView['status'][] = ['idle', 'running', 'waiting', 'stopped']

function sessionStatusOf(payload: unknown): AgentThreadView['status'] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const status = (payload as Record<string, unknown>).status
  return THREAD_STATUSES.find((known) => known === status)
}

function isForwardedProviderEvent(payload: unknown): payload is ForwardedProviderEvent {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  // A forwarded envelope always carries the provider event's own `type`; a
  // delta payload never does. That is what tells the two apart.
  return typeof p.type === 'string'
}

function itemKindForStream(stream: string): ChatItemKind {
  return stream === 'reasoning' ? 'reasoning' : 'assistant'
}

/** Folds one `thread.activity-appended` event into `items`, returning a new
 *  array. A delta is keyed by `itemId` alone — reasoning and text streams
 *  for the same logical turn arrive under different `itemId`s upstream, so
 *  no separate stream key is needed here to keep them apart. */
function applyDelta(items: ChatItem[], payload: ActivityAppendedPayload, createdAt: number): { items: ChatItem[]; gap: boolean } {
  const idx = items.findIndex((item) => item.id === payload.itemId)
  if (idx === -1) {
    // First delta for this item. A gap can only be detected relative to a
    // prior sequence, so the first chunk never counts as one — sequence 1
    // is the expected start, but treating any starting number as fine keeps
    // this tolerant of a replay tail that begins mid-item.
    const item: ChatItem = {
      id: payload.itemId,
      kind: itemKindForStream(payload.stream),
      text: payload.text,
      createdAt,
      updatedAt: createdAt,
      lastSequence: payload.sequence,
    }
    return { items: [...items, item], gap: false }
  }

  const existing = items[idx]
  const gap = payload.sequence > existing.lastSequence + 1
  const updated: ChatItem = {
    ...existing,
    text: existing.text + payload.text,
    // `createdAt` deliberately stays where it was; `updatedAt` is what moves,
    // so a turn's span covers the whole stream and not just its first chunk.
    updatedAt: createdAt,
    lastSequence: payload.sequence,
  }
  const next = items.slice()
  next[idx] = updated
  return { items: next, gap }
}

/** Folds a forwarded provider event into `items`: tool calls become a `tool`
 *  row that completes in place, runtime errors become an `error` row.
 *
 *  `item.completed` updates the row `item.started` created rather than
 *  appending a second one — they share an `itemId`, which is exactly what it
 *  is for. Anything else forwarded (session/turn bookkeeping) is deliberately
 *  not rendered; it advances `lastSeq` and nothing more. */
/** Reads `detail.toolCallId` without interpreting the rest of the payload.
 *  `detail` is whatever the provider sent — an object on `item.started`, the
 *  tool's own arguments on `item.completed`, or absent. */
function toolCallIdOf(detail: unknown): string | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined
  const id = (detail as Record<string, unknown>).toolCallId
  return typeof id === 'string' ? id : undefined
}

function applyForwarded(items: ChatItem[], eventId: string, ev: ForwardedProviderEvent, createdAt: number): ChatItem[] {
  const inner = ev.payload ?? {}

  if (ev.type === 'runtime.error' || inner.itemType === 'error') {
    const text = inner.message ?? inner.title ?? 'The agent reported an error.'
    return [...items, { id: eventId, kind: 'error', text, createdAt, updatedAt: createdAt, lastSequence: 0 }]
  }

  if (inner.itemType !== 'tool_call') return items

  const id = ev.itemId ?? eventId
  const idx = items.findIndex((item) => item.id === id)
  const started = ev.type !== 'item.completed'
  // On `item.started` the detail is the {toolCallId, name} envelope, not the
  // tool's arguments; only `item.completed` carries the real input.
  const input = started ? undefined : inner.detail

  if (idx === -1) {
    return [
      ...items,
      {
        id,
        kind: 'tool',
        text: inner.title ?? '',
        toolName: inner.title ?? 'Tool',
        status: started ? 'running' : inner.status === 'failed' ? 'failed' : 'done',
        toolCallId: toolCallIdOf(inner.detail),
        ...(input === undefined ? {} : { input }),
        createdAt,
        updatedAt: createdAt,
        lastSequence: 0,
      },
    ]
  }

  const next = items.slice()
  next[idx] = {
    ...items[idx],
    updatedAt: createdAt,
    ...(inner.title ? { toolName: inner.title } : {}),
    // A replayed tail can re-deliver an event that carries no detail. Keeping
    // the existing value is what makes reattach idempotent for this field.
    ...(toolCallIdOf(inner.detail) === undefined ? {} : { toolCallId: toolCallIdOf(inner.detail) }),
    ...(input === undefined ? {} : { input }),
    status: started ? items[idx].status : inner.status === 'failed' ? 'failed' : 'done',
  }
  return next
}

/**
 * Folds a batch of ordered `AgentEvent`s into a new `AgentThreadView`. Never
 * mutates `view` — the caller (a zustand slice) relies on referential
 * identity changing only when the view actually changed.
 *
 * Events whose `seq` is `<= view.lastSeq` are skipped: a reconnect replays
 * from the last seen `Seq`, and the server-side replay window can overlap
 * what the client already applied. Silently ignoring the overlap is what
 * makes reattach idempotent on this side of the wire.
 */
export function reduceAgentEvents(view: AgentThreadView, events: AgentEvent[]): AgentThreadView {
  let items = view.items
  let lastSeq = view.lastSeq
  let hasGap = view.hasGap
  let status = view.status
  let changed = false

  for (const event of events) {
    if (event.seq <= view.lastSeq) continue

    // Thread status, mirroring the backend projector: the turn-start intent
    // makes the thread running, and `thread.session-set` carries every later
    // transition (running / waiting / idle / stopped). Neither produces a chat
    // item — they only move the status.
    if (event.type === 'thread.turn-start-requested') {
      status = 'running'
    } else if (event.type === 'thread.session-set') {
      status = sessionStatusOf(event.payload) ?? status
    } else if (event.type === 'thread.message-sent' && isMessageSentPayload(event.payload)) {
      // The user's own message. Keyed by eventId, not itemId — it has no
      // provider item and never accumulates deltas.
      items = [
        ...items,
        { id: event.eventId, kind: 'user', text: event.payload.text, createdAt: event.createdAt, updatedAt: event.createdAt, lastSequence: 0 },
      ]
    } else if (isActivityAppendedPayload(event.payload)) {
      const result = applyDelta(items, event.payload, event.createdAt)
      items = result.items
      hasGap = hasGap || result.gap
    } else if (isForwardedProviderEvent(event.payload)) {
      items = applyForwarded(items, event.eventId, event.payload, event.createdAt)
    }

    lastSeq = event.seq
    changed = true
  }

  if (!changed) return view

  return {
    ...view,
    items,
    status,
    lastSeq,
    hasGap,
  }
}
