/**
 * Pure `Event[]` -> view-model reducer for one agent thread. No React, no
 * WebSocket — see `useAgentChatSocket.ts` for the stateful wrapper that
 * feeds this. Mirrors `orchestration.Apply` on the backend in spirit: it
 * folds an ordered event log into a read model, and it must be safe to
 * re-apply an overlapping tail after a reconnect-and-replay.
 */
import type { UserInputQuestion } from '@/features/agent-chat/pendingUserInput'
import type { AgentEvent, AgentThreadView, ChatItem, ChatItemKind, PendingApproval, PendingUserInput } from '@/features/agent-chat/types'

export function emptyThreadView(): AgentThreadView {
  return {
    items: [],
    status: 'idle',
    lastSeq: 0,
    hasGap: false,
    error: null,
    contextTokens: 0,
    pendingUserInputs: [],
    pendingApprovals: [],
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

/** One attachment reference on a sent message — mirrors
 *  `provider.Attachment`'s JSON tags exactly (`id`/`kind`/`mime`/`name`, not
 *  `mimeType`): `EvtThreadMessageSent`'s payload is the same
 *  `TurnStartPayload` object decoded off the socket, there is no separate
 *  echo shape to invent a second field name for. */
interface MessageAttachmentRef {
  id: string
  kind: string
  mime: string
  name: string
}

function isMessageAttachmentRefArray(value: unknown): value is MessageAttachmentRef[] {
  if (!Array.isArray(value)) return false
  return value.every(
    (a) =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as Record<string, unknown>).id === 'string' &&
      typeof (a as Record<string, unknown>).kind === 'string' &&
      typeof (a as Record<string, unknown>).mime === 'string' &&
      typeof (a as Record<string, unknown>).name === 'string',
  )
}

/** The user's own message — `TurnStartPayload` carried by
 *  `thread.message-sent`. Rendering this is what makes a sent message appear
 *  at all; the assistant's reply arrives later and separately. `attachments`
 *  is optional and, per every other guard in this file, never trusted beyond
 *  a shallow shape check even though the backend already validates it. */
interface MessageSentPayload {
  text: string
  attachments?: MessageAttachmentRef[]
}

function isMessageSentPayload(payload: unknown): payload is MessageSentPayload {
  if (typeof payload !== 'object' || payload === null) return false
  return typeof (payload as Record<string, unknown>).text === 'string'
}

/** The plan the agent proposed via `ExitPlanMode` — `event.ProposedPlanPayload`
 *  carried by `thread.plan-proposed`. Mirrors the backend event verbatim
 *  (`event/event.go`); `toolUseId` is what makes folding this event
 *  idempotent (see `openProposedPlan` below), the same role `itemId` plays
 *  for a tool call. `planFilePath` is metadata only (agent-host path — see
 *  the design spec's non-goals) and is not read on this side. */
interface ProposedPlanPayload {
  planMarkdown: string
  planFilePath?: string
  toolUseId?: string
}

function isProposedPlanPayload(payload: unknown): payload is ProposedPlanPayload {
  if (typeof payload !== 'object' || payload === null) return false
  return typeof (payload as Record<string, unknown>).planMarkdown === 'string'
}

/** A canonical provider event forwarded verbatim by Ingestion's fallback
 *  ("better to store an unrecognized event as activity than drop it"), so the
 *  activity-appended payload is a whole `event.Event` envelope rather than a
 *  delta. Tool calls arrive exclusively this way — `item.started` /
 *  `item.completed` with an `itemType` of `tool_call`. */
interface ForwardedProviderEvent {
  type: string
  itemId?: string
  requestId?: string
  /** `event.Event.Provider` — the agent kind that produced this event
   *  (`claude`, `pi`, …). Present on every forwarded envelope; read only off
   *  `turn.started`, to label the turn with what actually ran it. */
  provider?: string
  payload?: {
    /** `TurnStartedPayload.Model` — present only on `turn.started`. */
    model?: string
    itemType?: string
    title?: string
    status?: string
    message?: string
    /** `ToolDeniedPayload.ToolName` — present only on `tool.denied`, the event
     *  the parser emits when it auto-answers a `can_use_tool` on the operator's
     *  behalf. */
    toolName?: string
    /** `ItemStartedPayload.Detail` / `ItemCompletedPayload.Detail` — an opaque
     *  `json.RawMessage` on the wire, in one of two shapes depending on the
     *  provider. See `toolDetailParts` below, which is the only thing that
     *  interprets it. */
    detail?: unknown
    /** `UserInputRequestedPayload.Questions` — present only on `user-input.requested`. */
    questions?: unknown
    /** `RequestOpenedPayload`/`RequestResolvedPayload` fields — present only on
     *  `request.opened` / `request.resolved`. `detail` above is reused for
     *  `item.completed`'s tool input (`unknown`); this one is always the
     *  approval's own string detail, so it does not collide with that field's
     *  type. */
    requestType?: string
    decision?: string
    args?: unknown
    options?: unknown
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

/** `thread.session-set`'s `pendingRequestRemove` — the id of a request that was
 *  retired WITHOUT the user answering it (an approval that timed out, or one
 *  abandoned when the thread was interrupted). Mirrors the backend projector's
 *  own field of the same name. */
function sessionPendingRemoveOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const id = (payload as Record<string, unknown>).pendingRequestRemove
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** The `requestId` of a `thread.approval-response-requested` /
 *  `thread.user-input-response-requested` — the event the ENGINE writes when
 *  the user clicks a button on an approval card. Both carry `{requestId, …}`
 *  (`ApprovalRespondPayload` / `UserInputRespondPayload` in `command.go`). */
function respondedRequestIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const id = (payload as Record<string, unknown>).requestId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * `waiting` → `running` once nothing is pending any more — the client half of
 * `engine.go`'s `EvtThreadApprovalResponseRequested` / `pendingRequestRemove`
 * projections, which both end in
 * `if len(t.PendingRequests) == 0 && t.Status == ThreadWaiting { t.Status = ThreadRunning }`.
 *
 * ── Why this had to exist ──
 * The backend recomputes that transition in its own projector, so the event it
 * emits carries no `status` at all: `CmdThreadApprovalRespond` produces
 * `thread.approval-response-requested` with `{requestId, decision}`, and the
 * timeout path produces `thread.session-set` with `{pendingRequestRemove}`.
 * This reducer only ever read an explicit `payload.status`, so from the moment
 * an approval card was answered the CLIENT's view stayed `waiting` for the rest
 * of the thread's life while the server's said `running`.
 *
 * Two things are gated on `running` and both went missing for the whole turn:
 * `MessagesTimeline`'s `••• Working for 42s` row — the one answer to "is it
 * still going, or has it hung?" — and the turn stamp, which is suppressed while
 * a trailing turn is `running` OR `waiting`. So a turn that ran a single
 * approved command showed no progress and no timings from the click onwards.
 *
 * The backend keeps ONE `PendingRequests` map; this view splits it in two
 * (approvals and user-input questions), so "empty" here means both.
 */
function settleAfterPending(
  status: AgentThreadView['status'],
  approvals: PendingApproval[],
  userInputs: PendingUserInput[],
): AgentThreadView['status'] {
  if (status !== 'waiting') return status
  return approvals.length === 0 && userInputs.length === 0 ? 'running' : status
}

/** `thread.session-set`'s `contextTokens` — present only on the event that
 *  closes out a completed turn (`Ingestion.handle`'s `TurnCompleted` case),
 *  and only when the CLI actually reported usage. `0` is not a real reading
 *  for any completed turn, so — mirroring the backend projector's own
 *  presence check on this exact field — anything `<= 0` means "not on this
 *  event" rather than "the window is empty now". */
function sessionContextTokensOf(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const tokens = (payload as Record<string, unknown>).contextTokens
  return typeof tokens === 'number' && tokens > 0 ? tokens : undefined
}

/** `thread.session-set`'s per-turn usage, emitted alongside `contextTokens` by
 *  `Ingestion.handle`'s `TurnCompleted` case. Same presence rule as
 *  `contextTokens`: a completed turn always spends something, so `<= 0` means
 *  "this event carried no usage" rather than "the turn was free".
 *
 *  `total` is what the turn cost; `output` is the generated half, and the only
 *  one a tokens-per-second rate may be derived from — dividing the total by the
 *  turn's wall clock would count the prompt and the cache reads as if they had
 *  been produced at the keyboard, which inflates the rate by an order of
 *  magnitude on a long context. */
function sessionTurnUsageOf(payload: unknown): { total: number; output: number } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const p = payload as Record<string, unknown>
  const total = p.turnTokens
  if (typeof total !== 'number' || total <= 0) return undefined
  const output = p.turnOutputTokens
  return { total, output: typeof output === 'number' && output > 0 ? output : 0 }
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

/** Defensive shallow check on the normalized question shape carried by
 *  `user-input.requested`. The backend already guarantees this
 *  (`UserInputRequestedPayload.Questions`), but this file never trusts the
 *  wire beyond a shallow check, matching every other guard here. */
function isUserInputQuestionArray(value: unknown): value is UserInputQuestion[] {
  if (!Array.isArray(value)) return false
  return value.every(
    (q) =>
      typeof q === 'object' &&
      q !== null &&
      typeof (q as Record<string, unknown>).id === 'string' &&
      typeof (q as Record<string, unknown>).question === 'string' &&
      Array.isArray((q as Record<string, unknown>).options),
  )
}

/** Folds a `user-input.requested` event into `pending`, returning a new array
 *  (or the same one if nothing changed) — mirrors `applyDelta`'s contract. */
function openPendingUserInput(pending: PendingUserInput[], ev: ForwardedProviderEvent, createdAt: number): PendingUserInput[] {
  if (!ev.requestId) return pending
  if (pending.some((p) => p.requestId === ev.requestId)) return pending // idempotent replay
  const questions = ev.payload?.questions
  if (!isUserInputQuestionArray(questions)) return pending
  return [...pending, { requestId: ev.requestId, createdAt, questions }]
}

/** Folds a `user-input.resolved` event into `pending`, removing the matching
 *  request. Returns the same array if the request was already gone. */
function closePendingUserInput(pending: PendingUserInput[], requestId: string | undefined): PendingUserInput[] {
  if (!requestId) return pending
  const next = pending.filter((p) => p.requestId !== requestId)
  return next.length === pending.length ? pending : next
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

/** Folds a `request.opened` event into `pending`, returning a new array (or
 *  the same one if nothing changed) — mirrors `openPendingUserInput`'s
 *  contract. `options` are the wire `event.Decision` strings verbatim (never
 *  re-enumerated here — see `PendingApproval`'s doc comment in `types.ts`). */
function openPendingApproval(pending: PendingApproval[], ev: ForwardedProviderEvent, createdAt: number): PendingApproval[] {
  if (!ev.requestId) return pending
  if (pending.some((p) => p.requestId === ev.requestId)) return pending // idempotent replay
  const requestType = ev.payload?.requestType
  if (typeof requestType !== 'string') return pending
  return [
    ...pending,
    {
      requestId: ev.requestId,
      createdAt,
      requestType,
      detail: typeof ev.payload?.detail === 'string' ? ev.payload.detail : undefined,
      args: ev.payload?.args,
      options: isStringArray(ev.payload?.options) ? ev.payload.options : [],
    },
  ]
}

/** Folds a `request.resolved` event into `pending`, removing the matching
 *  request — regardless of `decision` (an `accept`/`decline`/`cancel`
 *  resolved event all retire the same way; `control_cancel_request`'s own
 *  synthesized resolve carries `decision: "cancel"`). Returns the same array
 *  if the request was already gone. */
function closePendingApproval(pending: PendingApproval[], requestId: string | undefined): PendingApproval[] {
  if (!requestId) return pending
  const next = pending.filter((p) => p.requestId !== requestId)
  return next.length === pending.length ? pending : next
}

/** Folds a `thread.plan-proposed` event into `items` as one `'plan'` item.
 *  Keyed by `toolUseId` when present, else the event's own `eventId` — the
 *  same idempotency contract `applyForwarded` gives a tool row via its
 *  `idx === -1` check. A plan never updates in place once captured (there is
 *  no started/completed pair the way a tool call has), so a duplicate
 *  delivery under the SAME key is dropped rather than folded. */
function openProposedPlan(items: ChatItem[], id: string, planMarkdown: string, createdAt: number): ChatItem[] {
  if (items.some((item) => item.id === id)) return items // idempotent replay
  return [...items, { id, kind: 'plan', text: planMarkdown, createdAt, updatedAt: createdAt, lastSequence: 0 }]
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

/**
 * A tool `detail` split into the call's ARGUMENTS and its RESULT.
 *
 * The two live providers disagree about the shape, and reading one as the
 * other is what put `{"toolCallId":…,"name":"bash","result":{…}}` on screen
 * where the command should be:
 *
 *  - **claude** (`provider/claude/parse.go`) sends `{toolCallId, name}` on
 *    `item.started`, and the tool's own raw arguments — `{"command":"ls"}` —
 *    as the whole `detail` on `item.completed`. It parses no `tool_result`,
 *    so it never reports an output at all.
 *  - **pi** (`provider/pi/parse.go`'s `toolDetail`) wraps both sides in one
 *    envelope: `{toolCallId, name, args}` on `item.started`, then
 *    `{toolCallId, name, result}` on `item.completed`.
 *
 * So pi's arguments arrive ONLY on `item.started` — which this reducer used
 * to discard wholesale ("only item.completed carries the real input", true of
 * claude alone) — and its `item.completed` detail is a result that was then
 * stored as `input`. `toolSummary` picked `name` out of that envelope, which
 * is why every pi tool row read `bash bash` and expanded to a result dump.
 *
 * `toolCallId` is the discriminator: every envelope either provider sends
 * carries it, and no real tool takes it as an argument. Present means "read
 * `args`/`result` out of this envelope"; absent means "this whole object IS
 * the arguments".
 */
function toolDetailParts(detail: unknown): { args?: unknown; result?: unknown } {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return {}
  const record = detail as Record<string, unknown>
  if (typeof record.toolCallId !== 'string') return { args: detail }
  return {
    ...(record.args === undefined ? {} : { args: record.args }),
    ...(record.result === undefined ? {} : { result: record.result }),
  }
}

function applyForwarded(items: ChatItem[], eventId: string, ev: ForwardedProviderEvent, createdAt: number): ChatItem[] {
  const inner = ev.payload ?? {}

  if (ev.type === 'runtime.error' || inner.itemType === 'error') {
    const text = inner.message ?? inner.title ?? 'The agent reported an error.'
    return [...items, { id: eventId, kind: 'error', text, createdAt, updatedAt: createdAt, lastSequence: 0 }]
  }

  // ── Things DevDeck decided, which the operator was never told ──
  //
  // Both of these already reached this function and fell straight through the
  // `itemType !== 'tool_call'` guard below into nothing, and both are the
  // moment a turn goes quiet for no visible reason.
  //
  //   tool.denied      the parser auto-answered a `can_use_tool` on the
  //                    operator's behalf — ExitPlanMode, and anything else it
  //                    cannot route to a real decision. `parse.go` emits this
  //                    event for the express purpose of making that denial
  //                    "visible in the transcript instead of invisible, which
  //                    is what today's silent-denial mode does". The backend
  //                    kept its half of that bargain; this side never did.
  //   runtime.warning  a control_request whose subtype DevDeck does not
  //                    implement (`set_permission_mode`, `set_model`,
  //                    `request_user_dialog`), or a line it could not parse.
  //                    The CLI blocks until something replies, so the parser
  //                    auto-denies with "DevDeck does not understand this
  //                    request and cannot act on it. Continue without it." —
  //                    the agent hears that sentence and the operator heard
  //                    nothing at all.
  //
  // Rendered as a `notice`, not an `error`: the turn did not fail, DevDeck just
  // declined something. What the operator needs is the sentence, not an alarm.
  if (ev.type === 'tool.denied') {
    const tool = typeof inner.toolName === 'string' && inner.toolName.length > 0 ? inner.toolName : 'A tool'
    const reason = inner.message ?? 'DevDeck declined it.'
    return [
      ...items,
      { id: eventId, kind: 'notice', text: `${tool} was not allowed to run. ${reason}`, createdAt, updatedAt: createdAt, lastSequence: 0 },
    ]
  }
  if (ev.type === 'runtime.warning') {
    const text = inner.message ?? 'DevDeck could not act on something the agent sent.'
    return [...items, { id: eventId, kind: 'notice', text, createdAt, updatedAt: createdAt, lastSequence: 0 }]
  }

  if (inner.itemType !== 'tool_call') return items

  const id = ev.itemId ?? eventId
  const idx = items.findIndex((item) => item.id === id)
  const started = ev.type !== 'item.completed'
  // Both events are read for both halves — see `toolDetailParts`. Which event
  // carries which half is the provider's business, not this reducer's, and
  // hard-coding claude's answer ("arguments live on item.completed") is what
  // silently threw pi's arguments away.
  const { args: input, result: output } = toolDetailParts(inner.detail)

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
        ...(output === undefined ? {} : { output }),
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
    // the existing value is what makes reattach idempotent for this field —
    // and for `input`, it is also what stops pi's argument-bearing
    // `item.started` from being overwritten by its result-bearing
    // `item.completed`, which carries no `args` at all.
    ...(toolCallIdOf(inner.detail) === undefined ? {} : { toolCallId: toolCallIdOf(inner.detail) }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
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
  let contextTokens = view.contextTokens
  let pendingUserInputs = view.pendingUserInputs
  // The agent/model the CURRENT turn is running on, carried from its
  // `turn.started` to the `thread.session-set` that closes it out, where it is
  // stamped onto the turn's last item exactly where the usage lands.
  //
  // SEEDED FROM THE VIEW, not fresh. These used to be plain locals, on the
  // reading that they are per-turn scratch — but the reducer is called once per
  // socket BATCH, not once per turn, and a live turn is dozens of batches
  // spread over its whole duration. `turn.started` lands in the first of them
  // and the closing session-set in the last, so by the time the stamp was
  // written the locals had been reset to `undefined` many times over and the
  // engine half of the turn stamp was silently dropped on every live turn. A
  // reconnect replay folds the entire log in ONE call, which is why it worked
  // there — and why every unit test, which does the same, passed.
  let turnAgent = view.turnAgent
  let turnModel = view.turnModel
  let pendingApprovals = view.pendingApprovals
  let changed = false

  for (const event of events) {
    if (event.seq <= view.lastSeq) continue

    // Thread status, mirroring the backend projector: the turn-start intent
    // makes the thread running, and `thread.session-set` carries every later
    // transition (running / waiting / idle / stopped). Neither produces a chat
    // item — they only move the status.
    if (event.type === 'thread.turn-start-requested') {
      status = 'running'
    } else if (event.type === 'thread.approval-response-requested' || event.type === 'thread.user-input-response-requested') {
      // The CLICKED path. `request.resolved` / `user-input.resolved` below only
      // ever cover the paths the user did NOT answer (timeout, interrupt) —
      // see `Ingestion.handle`'s own comment on that case. Answering a card
      // produces this event and nothing else, so without these two lines a
      // clicked approval left the card on screen and the thread `waiting`.
      const requestId = respondedRequestIdOf(event.payload)
      pendingApprovals = closePendingApproval(pendingApprovals, requestId)
      pendingUserInputs = closePendingUserInput(pendingUserInputs, requestId)
      status = settleAfterPending(status, pendingApprovals, pendingUserInputs)
    } else if (event.type === 'thread.session-set') {
      status = sessionStatusOf(event.payload) ?? status
      // A `pendingRequestRemove` carries no `status` of its own — the backend
      // recomputes the transition in its projector, so this side has to too.
      const removed = sessionPendingRemoveOf(event.payload)
      if (removed !== undefined) {
        pendingApprovals = closePendingApproval(pendingApprovals, removed)
        pendingUserInputs = closePendingUserInput(pendingUserInputs, removed)
        status = settleAfterPending(status, pendingApprovals, pendingUserInputs)
      }
      contextTokens = sessionContextTokensOf(event.payload) ?? contextTokens
      // Usage is a property of the turn that just ended, not of the thread, so
      // it is stamped onto that turn's last item — which is where
      // `MessagesTimeline` already anchors the turn stamp. Replaying the
      // thread reproduces it exactly; nothing is derived from render time.
      const usage = sessionTurnUsageOf(event.payload)
      if (usage && items.length > 0) {
        const last = items[items.length - 1]
        items = [
          ...items.slice(0, -1),
          {
            ...last,
            turnTokens: usage.total,
            turnOutputTokens: usage.output,
            // Spread conditionally: an explicit `undefined` would overwrite a
            // value a replay had already established for this item.
            ...(turnAgent ? { turnAgent } : {}),
            ...(turnModel ? { turnModel } : {}),
          },
        ]
      }
      // Cleared whatever the status, not just on idle: the next turn brings its
      // own `turn.started`, and carrying these across would label it with the
      // model that ran the previous one.
      turnAgent = undefined
      turnModel = undefined
    } else if (event.type === 'thread.message-sent' && isMessageSentPayload(event.payload)) {
      // The user's own message. Keyed by eventId, not itemId — it has no
      // provider item and never accumulates deltas.
      const attachments = isMessageAttachmentRefArray(event.payload.attachments) ? event.payload.attachments : undefined
      items = [
        ...items,
        {
          id: event.eventId,
          kind: 'user',
          text: event.payload.text,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          lastSequence: 0,
          ...(attachments ? { attachments } : {}),
        },
      ]
    } else if (event.type === 'thread.plan-proposed' && isProposedPlanPayload(event.payload)) {
      const id = event.payload.toolUseId ?? event.eventId
      items = openProposedPlan(items, id, event.payload.planMarkdown, event.createdAt)
    } else if (isActivityAppendedPayload(event.payload)) {
      const result = applyDelta(items, event.payload, event.createdAt)
      items = result.items
      hasGap = hasGap || result.gap
    } else if (isForwardedProviderEvent(event.payload) && event.payload.type === 'turn.started') {
      // Remembered, not rendered: `turn.started` has nothing to show on its
      // own. It is the only place the turn's agent and model appear, and they
      // are needed later, when the turn settles.
      turnAgent = event.payload.provider || undefined
      turnModel = event.payload.payload?.model || undefined
    } else if (isForwardedProviderEvent(event.payload) && event.payload.type === 'user-input.requested') {
      pendingUserInputs = openPendingUserInput(pendingUserInputs, event.payload, event.createdAt)
    } else if (isForwardedProviderEvent(event.payload) && event.payload.type === 'user-input.resolved') {
      pendingUserInputs = closePendingUserInput(pendingUserInputs, event.payload.requestId)
      status = settleAfterPending(status, pendingApprovals, pendingUserInputs)
    } else if (isForwardedProviderEvent(event.payload) && event.payload.type === 'request.opened') {
      pendingApprovals = openPendingApproval(pendingApprovals, event.payload, event.createdAt)
    } else if (isForwardedProviderEvent(event.payload) && event.payload.type === 'request.resolved') {
      pendingApprovals = closePendingApproval(pendingApprovals, event.payload.requestId)
      status = settleAfterPending(status, pendingApprovals, pendingUserInputs)
    } else if (isForwardedProviderEvent(event.payload)) {
      const before = items
      items = applyForwarded(items, event.eventId, event.payload, event.createdAt)
      // An error ends the turn, so it must also end the RUNNING state — the
      // backend settles the thread too (see `reportError`), but a transcript
      // that shows a failure while the composer still says Stop and the
      // timeline counts "Working for 1877s" is the exact trap this closes.
      // Belt and braces on purpose: this is the half the user cannot work
      // around, and it costs one comparison per event.
      if (items !== before && items[items.length - 1]?.kind === 'error' && status === 'running') {
        status = 'idle'
      }
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
    contextTokens,
    pendingUserInputs,
    pendingApprovals,
    turnAgent,
    turnModel,
  }
}
