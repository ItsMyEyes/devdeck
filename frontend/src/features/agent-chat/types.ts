import type { UserInputQuestion } from '@/features/agent-chat/pendingUserInput'

/** Mirrors backend/internal/agentcore/orchestration.Event. `threadKey` on the
 *  frontend IS `threadId` on the backend — one name per side, no mapping. */
export interface AgentEvent {
  seq: number
  eventId: string
  type: string
  threadId: string
  commandId: string
  createdAt: number
  payload?: unknown
}

/** `notice` is something DEVDECK did on the agent's behalf and the operator
 *  needs to know about — a control request it auto-denied, or one it did not
 *  understand. Not `error`: nothing crashed, and painting it red would make an
 *  ordinary "this isn't built yet" read as a failure. Not silence either, which
 *  is what it used to be — see `applyForwarded`'s `tool.denied` branch. */
export type ChatItemKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'error' | 'plan' | 'notice'

export interface ChatItem {
  id: string
  kind: ChatItemKind
  text: string
  /** Tool rows only; read-only in this spec — Allow/Deny arrives with approvals. */
  toolName?: string
  status?: 'running' | 'done' | 'failed'
  /** Tool rows only. The provider's own call id, from `item.started`'s
   *  `detail.toolCallId`. Carried so a future approvals feature can correlate
   *  a decision back to the call that asked for it. */
  toolCallId?: string
  /** Tool rows only. The tool's ARGUMENTS — whichever of `item.started` /
   *  `item.completed` its provider puts them on (see `eventReducer.ts`'s
   *  `toolDetailParts`). `unknown` because the shape is per-tool and must
   *  never be interpreted here beyond `toolSummary`'s best-effort read. */
  input?: unknown
  /** Tool rows only. The call's RESULT, for providers that report one — pi
   *  does (`tool_execution_end`), claude does not parse `tool_result` at all,
   *  so it is permanently absent there. Same `unknown` contract as `input`;
   *  `toolResultText` gets the readable text out of the common
   *  `{content:[{type:'text',text}]}` shape without this file having to know
   *  it. */
  output?: unknown
  /** Wall-clock of the event that CREATED this item (later deltas folded into
   *  it do not move it). Optional only so existing `ChatItem` fixtures keep
   *  compiling — the reducer always sets it. */
  createdAt?: number
  /** Wall-clock of the LAST event folded into this item. For a streamed
   *  assistant message `createdAt` is its time-to-first-token, so this is the
   *  only honest end of a turn's span — see `entryCompletedAt` in
   *  `adapter.ts`. Optional for the same fixture reason as `createdAt`. */
  updatedAt?: number
  /** Set on the LAST item of a turn, when `thread.session-set` closes that turn
   *  out with usage attached (see `sessionTurnUsageOf`). `turnTokens` is the
   *  whole turn's spend — input + output + both cache counters — and
   *  `turnOutputTokens` is the generated half, the only basis a tokens-per-
   *  second rate may use. Absent on every other item, and on turns whose
   *  provider reported no usage. */
  turnTokens?: number
  turnOutputTokens?: number
  /** Which agent and model actually ran this turn, stamped on the same last
   *  item as `turnTokens` and sourced from the turn's own `turn.started`.
   *  Deliberately not read from the composer's current pick: that shows what
   *  the NEXT turn will use, and a thread may switch models partway through,
   *  so using it would relabel a turn's history every time the pill changed.
   *  Absent on turns recorded before this existed. */
  turnAgent?: string
  turnModel?: string
  /** Highest delta sequence folded into this item, per stream. */
  lastSequence: number
  /** User rows only, present only when the message carried one or more
   *  uploaded attachments. `EvtThreadMessageSent`'s payload is the same
   *  `TurnStartPayload` object decoded off the socket, so these field names
   *  match `provider.Attachment`'s JSON tags exactly (`id`/`kind`/`mime`/
   *  `name` — deliberately not `mimeType`). Raw bytes are never carried here;
   *  a thumbnail is fetched separately via `fetchAgentAttachmentBlob`. */
  attachments?: { id: string; kind: string; mime: string; name: string }[]
}

/** One open `AskUserQuestion` request, derived from the forwarded
 *  `user-input.requested` / `user-input.resolved` events — mirrors the
 *  backend's `event.UserInputRequestedPayload` (normalized in Go, never
 *  here — see `pendingUserInput.ts`'s doc comment on why). */
export interface PendingUserInput {
  requestId: string
  createdAt: number
  questions: UserInputQuestion[]
}

/** One open approval request — mirrors the backend's `event.RequestOpenedPayload`
 *  plus the envelope's own `requestId`/`createdAt`. `requestType`/`options`
 *  are the wire strings verbatim (`event.RequestType`/`event.Decision`
 *  values, e.g. "command_execution_approval" / "acceptForSession") — this
 *  file does not re-enum them, matching how `AgentEvent.type` is left as a
 *  plain `string` rather than a TS union of every backend event type. */
export interface PendingApproval {
  requestId: string
  createdAt: number
  requestType: string
  detail?: string
  args?: unknown
  options: string[]
}

export interface AgentThreadView {
  items: ChatItem[]
  status: 'idle' | 'running' | 'waiting' | 'stopped'
  /** Highest Seq applied. Sent as `sinceSeq` when reconnecting. */
  lastSeq: number
  /** True when a delta arrived with a sequence gap — the UI shows a subtle
   *  marker rather than pretending the text is complete. */
  hasGap: boolean
  error: string | null
  /** The context window's occupancy as of the last completed turn — mirrors
   *  the backend's `Thread.ContextTokens` (see `orchestration/engine.go`).
   *  Zero before any turn has completed. There is deliberately no "max"
   *  alongside it: the CLI reports none, so the composer's context-window
   *  indicator (`ComposerControls.tsx`) divides by whichever window size is
   *  currently selected, not a value carried on the thread. */
  contextTokens: number
  /** Open `AskUserQuestion` requests, oldest first. `ComposerPendingUserInputPanel`
   *  renders only the head — see its own doc comment for the queue-of-one
   *  UI decision. */
  pendingUserInputs: PendingUserInput[]
  /** Open approval (`can_use_tool`) requests, oldest first. Mirrors
   *  `pendingUserInputs` — see `ComposerPendingApprovalPanel`'s doc comment
   *  for the queue-of-one UI decision. */
  pendingApprovals: PendingApproval[]
  /** Which agent and model the turn currently in flight is running on, carried
   *  from its `turn.started` to the `thread.session-set` that closes it out —
   *  at which point they are stamped onto that turn's last `ChatItem` and
   *  cleared here.
   *
   *  Per-turn scratch, but it has to live on the VIEW rather than inside
   *  `reduceAgentEvents`: the socket delivers a turn as many small batches, so
   *  `turn.started` and the session-set that closes the turn are two separate
   *  calls to the reducer, seconds apart. Held as locals they were always
   *  `undefined` by the time the stamp was written, and the engine half of
   *  every turn stamp went missing — live only. A reconnect REPLAY folds the
   *  whole log in one call, so it worked there, which is also why the unit
   *  tests never caught it. */
  turnAgent?: string
  turnModel?: string
}
