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
export type ChatItemKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'error' | 'plan' | 'notice' | 'question'

/** One question of an `AskUserQuestion` request, paired with the answer the
 *  operator gave it — the payload of a `question` chat item.
 *
 *  ── Why the transcript has to carry this ──
 *  Answering the card produced `thread.user-input-response-requested`, which the
 *  reducer used ONLY to close the pending prompt. So the question and the
 *  choice both vanished the instant the card closed: nothing in the thread
 *  recorded what the agent had asked or what it was told, and after a reload
 *  there was no trace at all — while the agent's next turn was already acting
 *  on the answer. */
export interface AnsweredQuestion {
  /** The question's own text. Also the key `UserInputRespondPayload.Answers` is
   *  keyed by (see that struct's comment in `orchestration/command.go`), which
   *  is what lets this be reconstructed from the response event alone. */
  question: string
  /** The question's short label, when the request is still in the view to read
   *  it from. Absent for a response whose `user-input.requested` fell outside
   *  the replay window. */
  header?: string
  /** What the operator picked: the option labels for a select, or the single
   *  free-text answer they typed. Multi-select carries several; everything else
   *  carries one. */
  chosen: string[]
  /** The picked options' own descriptions, keyed by label — the sentence under
   *  the option, which is usually where the actual consequence of the choice
   *  was written. Same availability caveat as `header`. */
  descriptions?: Record<string, string>
}

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
  /** The SUBAGENT this item's work belongs to, or absent for the main
   *  conversation — mirrors `event.Event.AgentID` (Go). An opaque grouping
   *  key; never parse it.
   *
   *  `timeline.ts` pulls every item carrying one out of the main flow and
   *  folds it under the agent's own row, so a subagent that reads forty files
   *  costs the transcript exactly one line whatever it does inside. An item
   *  that lost this stamp would leak into the parent's narrative as if the
   *  main agent had done it. */
  agentId?: string
  /** Highest delta sequence folded into this item, per stream. */
  lastSequence: number
  /** User rows only, present only when the message carried one or more
   *  uploaded attachments. `EvtThreadMessageSent`'s payload is the same
   *  `TurnStartPayload` object decoded off the socket, so these field names
   *  match `provider.Attachment`'s JSON tags exactly (`id`/`kind`/`mime`/
   *  `name` — deliberately not `mimeType`). Raw bytes are never carried here;
   *  a thumbnail is fetched separately via `fetchAgentAttachmentBlob`. */
  attachments?: { id: string; kind: string; mime: string; name: string }[]
  /** `question` rows only: the `AskUserQuestion` request this row records the
   *  answer to, one entry per question in the order the agent asked them. See
   *  `AnsweredQuestion` for why the transcript keeps this at all. */
  answeredQuestions?: AnsweredQuestion[]
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

/** Mirrors `provider.RuntimeMode` (`backend/internal/agentcore/provider/provider.go`)
 *  — string values match exactly, one enum on both sides of the wire. */
export type RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'

/** Mirrors `provider.InteractionMode`. */
export type InteractionMode = 'default' | 'plan'

export const RUNTIME_MODES: readonly RuntimeMode[] = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
export const INTERACTION_MODES: readonly InteractionMode[] = ['default', 'plan']

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return typeof value === 'string' && (RUNTIME_MODES as readonly string[]).includes(value)
}

export function isInteractionMode(value: unknown): value is InteractionMode {
  return typeof value === 'string' && (INTERACTION_MODES as readonly string[]).includes(value)
}

/** What a subagent has spent — mirrors Go's `event.TaskUsage`. Deliberately
 *  narrower than a turn's usage: providers report a subagent's cost as one
 *  running total plus a tool count, never the input/output/cache breakdown,
 *  and inventing zeros for the rest would read as "no cache reads" rather
 *  than "not reported".
 *
 *  Cumulative, not deltas — every provider observed reports a running total,
 *  so the reducer merges by taking the LARGER value. Summing would
 *  double-count on every progress tick. */
export interface SubagentUsage {
  totalTokens?: number
  toolUses?: number
  durationMs?: number
}

/** One subagent's life, folded from the `task.*` events the backend forwards.
 *
 *  Derived in the client rather than projected onto the backend's `Thread`,
 *  which makes it replay-correct by construction: the same durable events
 *  produce the same roster on every reconnect, and the engine's read model
 *  did not have to grow a field.
 *
 *  Identity (`title`/`role`) is repeated by the backend on the progress and
 *  terminal rows, not just the start, so an agent whose start row fell
 *  outside the replay window still renders completely. */
export interface SubagentRecord {
  /** The grouping key every attributed item carries as `ChatItem.agentId`. */
  id: string
  /** The tool call that SPAWNED it, when the provider says. This is what
   *  anchors the agent's row in place of that call's row — the parent's own
   *  tool item carries the same value as `toolCallId`. */
  toolCallId?: string
  /** The provider's own task id, kept for debugging; never used for grouping
   *  (only `id` is), because it is absent from every content frame. */
  taskId?: string
  /** The job, in words: claude's `description` ("Run three echo commands"). */
  title?: string
  /** The agent kind — claude's `subagent_type`, opencode's agent name. */
  role?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  /** The most recent progress line, and the tool it was last seen running. */
  progress?: string
  lastTool?: string
  /** Its report back to the parent, on the terminal row. The single most
   *  useful thing it produces — it is what the parent actually consumes. */
  summary?: string
  usage?: SubagentUsage
  createdAt: number
  updatedAt: number
}

export interface AgentThreadView {
  items: ChatItem[]
  /** Subagents this thread has spawned, oldest first — see `SubagentRecord`.
   *  Empty for the overwhelming majority of threads, which never spawn one. */
  subagents: SubagentRecord[]
  status: 'idle' | 'running' | 'waiting' | 'stopped'
  /** The thread's ACTUAL permission policy — mirrors the backend's
   *  `Thread.Mode` (`orchestration/engine.go`), seeded from `thread.created`
   *  and moved by every `thread.runtime-mode-set` since, whichever client
   *  sent it (this composer, another pane, Telegram's mode keyboard).
   *
   *  This is what the composer's Permission pill shows and what the pending
   *  approval card's mode buttons read. It used to be component state in
   *  `AgentChatPane` defaulting to `approval-required`, which was right until
   *  the first remount: every tab, pane or SSH-session switch reset it, so a
   *  thread running in full access showed "Approval required" — and the
   *  pill's revert-on-rejection had nothing true to revert to. */
  runtimeMode: RuntimeMode
  /** The thread's actual collaboration mode — mirrors `Thread.Interact`, same
   *  provenance and same reasoning as `runtimeMode`. Read by the `/plan` and
   *  `/build` slash commands' effect (the plan follow-up banner and the
   *  Implement/Refine action). */
  interactionMode: InteractionMode
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
