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

/** Shape of the payload carried by `thread.activity-appended` — the only
 *  event type this reducer folds into item text so far. Other event types
 *  pass through untouched in this spec; later specs extend this switch. */
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

function itemKindForStream(stream: string): ChatItemKind {
  return stream === 'reasoning' ? 'reasoning' : 'assistant'
}

/** Folds one `thread.activity-appended` event into `items`, returning a new
 *  array. A delta is keyed by `itemId` alone — reasoning and text streams
 *  for the same logical turn arrive under different `itemId`s upstream, so
 *  no separate stream key is needed here to keep them apart. */
function applyDelta(items: ChatItem[], payload: ActivityAppendedPayload): { items: ChatItem[]; gap: boolean } {
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
      lastSequence: payload.sequence,
    }
    return { items: [...items, item], gap: false }
  }

  const existing = items[idx]
  const gap = payload.sequence > existing.lastSequence + 1
  const updated: ChatItem = {
    ...existing,
    text: existing.text + payload.text,
    lastSequence: payload.sequence,
  }
  const next = items.slice()
  next[idx] = updated
  return { items: next, gap }
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
  let changed = false

  for (const event of events) {
    if (event.seq <= view.lastSeq) continue

    if (isActivityAppendedPayload(event.payload)) {
      const result = applyDelta(items, event.payload)
      items = result.items
      hasGap = hasGap || result.gap
    }

    lastSeq = event.seq
    changed = true
  }

  if (!changed) return view

  return {
    ...view,
    items,
    lastSeq,
    hasGap,
  }
}
