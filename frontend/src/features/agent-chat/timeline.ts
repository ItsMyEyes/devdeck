/**
 * Pure grouping of an `AgentThreadView`'s flat item list into renderable
 * timeline entries. Kept separate from `eventReducer.ts` because grouping
 * ("consecutive tool calls become one row") is a presentation concern, not
 * part of the event-sourced read model — the reducer's `ChatItem[]` stays
 * the single source of truth, and this is purely a view over it.
 */
import type { AgentThreadView, ChatItem, SubagentRecord } from '@/features/agent-chat/types'

export interface MessageEntry {
  kind: 'message'
  item: ChatItem
}

export interface ReasoningEntry {
  kind: 'reasoning'
  item: ChatItem
  /** Reasoning is verbose relative to the final answer, so entries start
   *  collapsed; the user expands them explicitly. */
  collapsed: boolean
}

export interface ToolGroupEntry {
  kind: 'tool-group'
  items: ChatItem[]
}

export interface PlanEntry {
  kind: 'plan'
  item: ChatItem
}

/** One subagent, and everything it did, as a SINGLE row in the main flow.
 *
 *  This is the quiet-timeline rule: a subagent that reads forty files and
 *  writes ten must cost the parent's narrative exactly one line, or the
 *  operator's own conversation is buried under work they delegated precisely
 *  so they would not have to watch it. The detail is not thrown away — it is
 *  one click down, inside this entry. */
export interface SubagentEntry {
  kind: 'subagent'
  record: SubagentRecord
  /** The agent's own transcript, in order: its narration, reasoning and tool
   *  calls. Empty while it is starting up, or when the provider forwards no
   *  interior detail at all (pi, and claude on a CLI too old for
   *  `--forward-subagent-text`) — the row still renders, from the lifecycle
   *  events alone. */
  items: ChatItem[]
}

export type TimelineEntry = MessageEntry | ReasoningEntry | ToolGroupEntry | PlanEntry | SubagentEntry

/**
 * Groups `view.items` in order. Consecutive `tool` items collapse into a
 * single `tool-group` entry — a turn that reads three files and edits one
 * should render as one compact block, not four separate rows. Any
 * non-`tool` item breaks the run, so two tool calls either side of an
 * assistant message form two separate groups.
 */
export function buildTimeline(view: AgentThreadView): TimelineEntry[] {
  const entries: TimelineEntry[] = []

  // ── Subagents ──
  //
  // Every item a subagent produced is pulled OUT of the main flow and folded
  // under its agent's own row. The row is placed where the spawning tool call
  // was, so the agent appears exactly where the parent asked for it rather
  // than wherever its first output happened to land.
  const records = view.subagents ?? []
  const byAgent = new Map<string, ChatItem[]>()
  for (const record of records) byAgent.set(record.id, [])
  for (const item of view.items) {
    if (!item.agentId) continue
    const owned = byAgent.get(item.agentId)
    // An item whose agent has no record yet (its `task.started` has not
    // arrived, or fell outside the replay window) still gets a bucket — see
    // the orphan pass below. Hiding an agent's work because its opening frame
    // is missing would be the silence this whole feature exists to end.
    if (owned) owned.push(item)
    else byAgent.set(item.agentId, [item])
  }
  const recordFor = (id: string): SubagentRecord =>
    records.find((record) => record.id === id) ?? { id, status: 'running', createdAt: 0, updatedAt: 0 }
  // Which spawning tool call anchors which agent.
  const anchorToAgent = new Map<string, string>()
  for (const record of records) {
    if (record.toolCallId) anchorToAgent.set(record.toolCallId, record.id)
  }
  const emitted = new Set<string>()
  const pushSubagent = (agentId: string) => {
    if (emitted.has(agentId)) return
    emitted.add(agentId)
    entries.push({ kind: 'subagent', record: recordFor(agentId), items: byAgent.get(agentId) ?? [] })
  }

  for (const item of view.items) {
    if (item.agentId) {
      // Absorbed. If nothing anchors this agent — no spawning tool row in the
      // window, or a provider that reports none — its row lands here, at its
      // first piece of visible work, which is the closest honest position.
      const anchored = records.some((record) => record.id === item.agentId && record.toolCallId)
      if (!anchored) pushSubagent(item.agentId)
      continue
    }

    // The tool call that spawned an agent becomes that agent's row: the two
    // are the same event, and rendering both would show the spawn twice.
    if (item.kind === 'tool' && item.toolCallId) {
      const agentId = anchorToAgent.get(item.toolCallId)
      if (agentId) {
        pushSubagent(agentId)
        continue
      }
    }

    if (item.kind === 'tool') {
      const last = entries[entries.length - 1]
      if (last && last.kind === 'tool-group') {
        last.items.push(item)
      } else {
        entries.push({ kind: 'tool-group', items: [item] })
      }
      continue
    }

    if (item.kind === 'reasoning') {
      entries.push({ kind: 'reasoning', item, collapsed: true })
      continue
    }

    if (item.kind === 'plan') {
      entries.push({ kind: 'plan', item })
      continue
    }

    entries.push({ kind: 'message', item })
  }

  // An agent that has announced itself but whose anchor row is not in this
  // window and which has produced nothing yet — the ordinary state for the
  // second or two between `task.started` and its first output. Appended last,
  // which is where it belongs: it is the newest thing that has happened.
  for (const record of records) pushSubagent(record.id)

  return entries
}

/** t3code's `MAX_VISIBLE_WORK_LOG_ENTRIES` — a turn that reads twenty files
 *  renders as one visible row plus a disclosure, not twenty rows pushing the
 *  prose off screen. */
export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1

export interface WorkLogCollapse {
  /** The newest `maxVisible` entries — always rendered. */
  visible: ChatItem[]
  /** The earlier entries, folded behind a `▸ N earlier steps` disclosure.
   *  Empty means no disclosure should render at all. */
  hidden: ChatItem[]
}

/**
 * Splits one tool-group's items into the newest `maxVisible` (always shown)
 * and everything before them (folded behind a disclosure). Order is
 * preserved in both halves — `items` is chronological, so "newest" is the
 * tail of the array.
 */
export function collapseWorkLog(items: ChatItem[], maxVisible: number = MAX_VISIBLE_WORK_LOG_ENTRIES): WorkLogCollapse {
  if (items.length <= maxVisible) return { visible: items, hidden: [] }
  const splitAt = items.length - maxVisible
  return { hidden: items.slice(0, splitAt), visible: items.slice(splitAt) }
}

export interface TurnBoundary {
  /** Stable key for this turn — the id of the leading `user` message entry,
   *  or a synthetic `turn-<index>` key for a run of entries with no leading
   *  user message (e.g. the thread's very first turn, replayed mid-stream). */
  key: string
  /** Index into `entries` of this turn's last entry — where a turn stamp
   *  renders, once the turn is complete. */
  lastEntryIndex: number
}

/**
 * Splits `buildTimeline`'s output into turns: a run of entries starting at
 * each `user` message (inclusive) and ending right before the next one, or
 * at the end of the list. Pure grouping only — `MessagesTimeline.tsx` pairs
 * this with wall-clock timestamps it observes itself (see that file's doc
 * comment on why: `ChatItem` carries no timestamp yet).
 */
export function turnBoundaries(entries: TimelineEntry[]): TurnBoundary[] {
  const turns: TurnBoundary[] = []

  entries.forEach((entry, index) => {
    const startsTurn = entry.kind === 'message' && entry.item.kind === 'user'
    if (startsTurn || turns.length === 0) {
      const key = entry.kind === 'message' ? entry.item.id : `turn-${index}`
      turns.push({ key, lastEntryIndex: index })
    } else {
      turns[turns.length - 1].lastEntryIndex = index
    }
  })

  return turns
}

/** Formats a completed turn's footer — `2:40:02 PM • 10s` — matching
 *  t3code's per-turn stamp. Pure formatting only; see `MessagesTimeline.tsx`
 *  for where `startedAt`/`completedAt` come from. */
export function formatTurnStamp(startedAt: number, completedAt: number): string {
  const time = new Date(completedAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
  const seconds = Math.max(0, Math.round((completedAt - startedAt) / 1000))
  return `${time} • ${seconds}s`
}

/** `1.2k` / `847` / `12.4k`, the same compact shape the composer's context
 *  indicator uses. Whole thousands lose the decimal (`5k`, not `5.0k`). */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const thousands = tokens / 1000
  return `${thousands >= 10 || Number.isInteger(thousands) ? Math.round(thousands) : thousands.toFixed(1)}k`
}

/**
 * The token half of a turn's stamp: `12.4k tokens · 38 tok/s`.
 *
 * The rate is OUTPUT tokens over the turn's wall clock, which is what
 * "tokens per second" means everywhere else — the prompt and the cache reads
 * were not generated, and dividing the total by the duration reports a rate
 * several times higher than the model ever produced.
 *
 * Returns null when the provider reported no usage (not every CLI does), so
 * the caller renders the plain time stamp rather than `0 tokens`. The rate is
 * dropped on its own when the turn is too short to measure or nothing was
 * generated — a sub-second turn would otherwise read as an absurd rate.
 */
export function formatTurnTokens(
  turnTokens: number | undefined,
  outputTokens: number | undefined,
  startedAt: number,
  completedAt: number,
): string | null {
  if (turnTokens === undefined || turnTokens <= 0) return null
  const label = `${formatTokens(turnTokens)} tokens`
  const seconds = (completedAt - startedAt) / 1000
  if (!outputTokens || outputTokens <= 0 || seconds < 1) return label
  return `${label} · ${Math.round(outputTokens / seconds)} tok/s`
}

/**
 * Which agent and model actually ran the turn — `claude · claude-sonnet-5`.
 *
 * Read off the turn itself rather than the composer's current pick, because
 * the two genuinely diverge: the pill shows what the NEXT turn will use, and
 * a thread can switch models partway through. A transcript that labelled every
 * turn with today's selection would misreport its own history.
 *
 * Null when neither is known, so the caller renders the plain stamp instead of
 * a stray separator. Turns recorded before this field existed are exactly that
 * case.
 */
export function formatTurnEngine(agent: string | undefined, model: string | undefined): string | null {
  const parts = [agent, model].filter((part): part is string => !!part && part.length > 0)
  return parts.length === 0 ? null : parts.join(' · ')
}
