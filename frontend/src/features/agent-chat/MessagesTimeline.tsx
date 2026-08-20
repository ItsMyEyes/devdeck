/**
 * Renders `buildTimeline(view)` through the vendored AI Elements components.
 * Purely presentational: grouping lives in `timeline.ts` (pure, unit-tested),
 * the model-to-props mapping lives in `adapter.ts` (pure, unit-tested), and
 * this file only decides which component each `TimelineEntry` becomes.
 *
 * The one piece of state it owns is legitimately a UI concern: which
 * reasoning blocks and tool groups the user has expanded. `buildTimeline`
 * recomputes `collapsed: true` on every call, so it cannot hold that itself.
 *
 * ── Layout ──
 * A transcript is a reading surface, so it is a single centred measure
 * (`max-w-3xl`) rather than the full pane width, and it is set in the UI
 * sans (Arial) at 14px — not in mono. Mono is for code, and it is still what
 * code blocks, tool arguments and the terminal use; running an agent's prose
 * through it was costing ~15% of the reading width in advance and made a
 * markdown reply indistinguishable from command output.
 *
 * Only two shapes carry a bubble: the user's own turn (a right-aligned pill)
 * and an error (an alert). The agent's reply is plain text on the pane, which
 * is what lets its markdown — headings, lists, tables — actually read as a
 * document instead of as a chat bubble's contents.
 *
 * Turn stamps come from `ChatItem.createdAt` (the orchestration event's own
 * timestamp). The previous implementation read `Date.now()` during render and
 * cached it in a ref, because `ChatItem` carried no timestamp; that hack and
 * its "approximate after a reconnect replays a whole thread" caveat are both
 * gone.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, ChevronRight, Copy, History, ImageOff, Info, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger, useReasoning } from '@/components/ai-elements/reasoning'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { CODE_FENCE_COMPONENTS } from '@/features/agent-chat/CollapsibleCodeBlock'
import { Task, TaskCompactContent, TaskContent, TaskTrigger } from '@/components/ai-elements/task'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { Tool, ToolCompactHeader, ToolContent } from '@/components/ai-elements/tool'
import { entryCompletedAt, entryCreatedAt, messageRole, toolDisplayName, toolResultText, toolSummary, toolUIState, turnSpans, withHardBreaks } from '@/features/agent-chat/adapter'
import { ProposedPlanCard } from '@/features/agent-chat/ProposedPlanCard'
import { ChangedFilesCard } from '@/features/agent-chat/ChangedFilesCard'
import { changedFilesOf } from '@/features/agent-chat/changedFiles'
import { buildTimeline, collapseWorkLog, formatTurnEngine, formatTurnStamp, formatTurnTokens } from '@/features/agent-chat/timeline'
import type { ReasoningEntry, TimelineEntry, ToolGroupEntry } from '@/features/agent-chat/timeline'
import { extractTrailingTerminalContexts } from '@/features/agent-chat/terminalContext'
import type { TerminalContextEntry } from '@/features/agent-chat/terminalContext'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'
import { fetchAgentAttachmentBlob } from '@/lib/machineApi'
import type { Machine } from '@/store/types'

export interface MessagesTimelineProps {
  view: AgentThreadView
  /** Only ever needed when some `ChatItem` in `view.items` carries
   *  `.attachments` — `AttachmentThumbnail` below fetches each one's bytes
   *  through this machine. Optional and defaulted (`NO_MACHINE`, mirroring
   *  `ChatComposer.tsx`'s own fallback) so `MessagesTimeline.test.tsx`'s many
   *  pre-attachment fixtures — none of which carry `.attachments` — never
   *  need to supply one. */
  machine?: Machine
}

/** See `MessagesTimelineProps.machine`'s doc comment — never actually
 *  dereferenced unless a fixture supplies `.attachments` with no `machine`. */
const NO_MACHINE: Machine = { id: '', name: '', url: '', key: '', isLocal: false, signingPublicKey: '' }

/** The transcript's reading measure. Everything in the column — messages,
 *  tool cards, the composer above it — shares this width so the eye tracks a
 *  single left edge down the thread. */
const COLUMN = 'mx-auto flex w-full max-w-3xl flex-col'

/**
 * ── One box for every row of the work log ──
 *
 * A turn is a stack of short status rows — a tool call, a reasoning block, the
 * "N earlier steps" fold, the live "Working for 42s" — and each of the four was
 * its own shape. Tool rows carried a 14px status glyph and 4px of vertical
 * padding; reasoning rows carried no glyph and no padding; the fold carried a
 * 16px magnifier; the working row carried three 5px dots. So the labels sat on
 * three different left edges (0px, 24px, 28px) and every row reserved a
 * different amount of air, which is what made an otherwise ordinary turn read
 * as randomly spaced.
 *
 * This is that one box: a 14px glyph slot, an 8px gap, then the label. The
 * measurements are `ToolCompactHeader`'s, because tool rows are by far the most
 * numerous and were the only ones already carrying a glyph — every other row
 * moved to meet them.
 */
const ACTIVITY_ROW = 'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors'

/** ...and the same shell's interactive half, for the three rows that are
 *  triggers. `WorkingRow` is the one that is not. */
const ACTIVITY_ROW_INTERACTIVE = 'cursor-pointer hover:bg-devdeck-raised'

/** An expanded call's arguments and result. They are a supporting detail under
 *  a one-line row, not a document, so the vendored block's `p-4 text-sm` — a
 *  full 16px frame around 14px mono — is dialled back to the 12.5px the
 *  transcript's own markdown fences settled on, which is what stops a
 *  three-line JSON object from occupying more height than the tool call it
 *  belongs to. Reached through arbitrary variants because `CodeBlock`'s
 *  `className` lands on its container, not on the `pre` carrying the padding. */
const TOOL_DETAIL_CODE = 'border-devdeck-hairline [&_code]:text-[12.5px] [&_pre]:p-3 [&_pre]:text-[12.5px]'

/** The label's own left offset inside `ACTIVITY_ROW`: `px-1.5` (6) + the glyph
 *  slot (14) + `gap-2` (8). Anything that has to hang under a row's TEXT rather
 *  than under its box — expanded reasoning, for one — indents by this instead of
 *  by a guess that drifts the moment the glyph slot changes. */
const ACTIVITY_GUTTER = 'ml-7'

/** The 14px leading slot every activity row opens with. Mirrors the span
 *  `ToolCompactHeader` wraps its own status glyph in, so a lucide icon handed to
 *  either lands on the same pixels. */
function ActivityGlyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('flex size-3.5 flex-none items-center justify-center [&>svg]:size-3.5', className)}>
      {children}
    </span>
  )
}

/** Whether an entry belongs to the work log (which stacks flush) or reads as
 *  prose (which gets a paragraph break). See the gap comment in
 *  `MessagesTimeline` for why the transcript needs both. */
function isWorkEntry(entry: TimelineEntry | undefined): boolean {
  return entry?.kind === 'reasoning' || entry?.kind === 'tool-group'
}

/** Every `ChatItem` inside one turn's entry range, flattened back out of the
 *  grouping `buildTimeline` applied. `changedFilesOf` wants the turn's tool
 *  calls, and grouping is precisely what put them inside a `tool-group` entry
 *  where a per-entry walk cannot see them. */
function turnItems(entries: TimelineEntry[], span: { firstEntryIndex: number; lastEntryIndex: number }): ChatItem[] {
  const items: ChatItem[] = []
  for (let i = span.firstEntryIndex; i <= span.lastEntryIndex; i++) {
    const entry = entries[i]
    if (entry === undefined) continue
    if (entry.kind === 'tool-group') items.push(...entry.items)
    else items.push(entry.item)
  }
  return items
}

function entryKey(entry: TimelineEntry, index: number): string {
  if (entry.kind === 'tool-group') return entry.items[0]?.id ?? `tool-group-${index}`
  return entry.item.id
}

/** An agent-reported failure. Deliberately not a `Message`: it is not part of
 *  the conversation, and it must reach a screen reader as an alert. */
function ErrorRow({ item }: { item: ChatItem }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 self-stretch rounded-xl border border-devdeck-red-tint-strong-border bg-devdeck-red-tint px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-devdeck-err"
    >
      <AlertTriangle size={14} className="mt-0.5 flex-none" aria-hidden="true" />
      <span className="min-w-0">{item.text}</span>
    </div>
  )
}

/**
 * Something DevDeck declined on the agent's behalf — a `can_use_tool` the
 * parser auto-answered, or a control request whose subtype it does not
 * implement. See `applyForwarded`'s `tool.denied` / `runtime.warning` branches
 * for why this row has to exist at all: both events were reduced to nothing,
 * and a turn that goes quiet because DevDeck silently said no is
 * indistinguishable, from the operator's chair, from an agent that simply
 * stopped.
 *
 * Deliberately quieter than `ErrorRow`: no alert role, no red. Nothing failed —
 * the agent asked for something and got a documented refusal, which it was told
 * about and the operator was not. `status`, so a screen reader hears it without
 * the transcript being interrupted the way an alert would.
 */
function NoticeRow({ item }: { item: ChatItem }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 self-stretch rounded-xl border border-devdeck-hairline bg-devdeck-raised px-3.5 py-2.5 text-[13px] leading-relaxed text-devdeck-fg-2"
    >
      <Info size={14} className="mt-0.5 flex-none text-devdeck-wait" aria-hidden="true" />
      <span className="min-w-0 whitespace-pre-wrap">{item.text}</span>
    </div>
  )
}

/** One `ChatItem.attachments` entry — see that field's doc comment in
 *  `types.ts` for why the keys are `id`/`kind`/`mime`/`name`, not `mimeType`. */
type MessageAttachment = NonNullable<ChatItem['attachments']>[number]

/**
 * A user turn's attached image. `GET /api/agent/attachments/{id}` cannot be
 * used as a plain `<img src>`: that route lives on a runtime, which is
 * key-only auth, and a bare `<img src>` has no way to carry the
 * `Authorization` header a direct (non-hub-proxied) connection needs
 * (CONTRACTS.md's key-auth section rejects `?key=` on a non-WebSocket-upgrade
 * request). So this fetches the bytes through `fetchAgentAttachmentBlob`
 * (`machineXhr`, same direct-first/proxy routing every other machine-scoped
 * transfer uses) and renders an `URL.createObjectURL(blob)`, revoked on
 * unmount or if the attachment identity changes.
 *
 * A small dedicated component so this fetch/revoke lifecycle isn't
 * duplicated per-thumbnail inline in `MessageRow` below.
 */
function AttachmentThumbnail({ machine, attachment }: { machine: Machine; attachment: MessageAttachment }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    setSrc(null)
    setFailed(false)
    fetchAgentAttachmentBlob(machine, attachment.id)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [machine, attachment.id])

  if (failed) {
    return (
      <div
        role="img"
        aria-label={`${attachment.name} failed to load`}
        title={attachment.name}
        className="flex size-16 flex-none items-center justify-center rounded-lg border border-devdeck-hairline bg-devdeck-raised text-devdeck-err"
      >
        <ImageOff size={16} aria-hidden="true" />
      </div>
    )
  }

  if (!src) {
    return (
      <div
        aria-hidden="true"
        className="size-16 flex-none animate-pulse rounded-lg border border-devdeck-hairline bg-devdeck-raised"
      />
    )
  }

  return <img src={src} alt={attachment.name} className="size-16 flex-none rounded-lg border border-devdeck-hairline object-cover" />
}

/** A conversation turn.
 *
 *  The user's turn is a right-aligned pill on the raised surface — neutral,
 *  not accent-tinted: DESIGN.md reserves the accent for the focus ring, the
 *  state bar, links and the single primary action per screen, and "every
 *  message you have ever sent" is none of those. The agent's turn has no
 *  bubble at all.
 *
 *  Only the AGENT's text goes through markdown. The user's own text is
 *  rendered verbatim in a pre-wrap block: it is a literal prompt, not a
 *  document, and running it through Streamdown drops `<div>` as an HTML tag,
 *  eats the underscores of `__init__`, turns a pasted `# comment` into an H1,
 *  and collapses the newlines of a Shift+Enter message.
 *
 *  `machine` is only used to fetch attachment thumbnails (`AttachmentThumbnail`
 *  above) — the agent branch never touches it.
 *
 *  `contextsExpanded`/`onToggleContexts` drive `TerminalContextDisclosure`
 *  below (design spec C3, "Display must strip it") — only a user turn can
 *  carry a trailing `<terminal_context>` block (`ChatComposer`'s C3 bridge
 *  only ever appends one to what the user sends), so the agent branch never
 *  runs `extractTrailingTerminalContexts` at all. */
function MessageRow({
  item,
  stamp,
  machine,
  contextsExpanded,
  onToggleContexts,
}: {
  item: ChatItem
  stamp?: ReactNode
  machine: Machine
  contextsExpanded: boolean
  onToggleContexts: () => void
}) {
  const isUser = item.kind === 'user'
  const attachments = item.attachments ?? []
  const { visibleText, copyText, contexts } = isUser
    ? extractTrailingTerminalContexts(item.text)
    : { visibleText: item.text, copyText: item.text, contexts: [] as TerminalContextEntry[] }
  return (
    // `relative` anchors `MessageFooter`'s out-of-flow copy button — see its
    // doc comment for why that button is not in the flex flow.
    <Message from={messageRole(item.kind)} className={cn('relative', isUser ? 'max-w-[82%]' : 'max-w-full')}>
      <MessageContent
        className={cn(
          'text-[14px]',
          isUser
            ? 'leading-relaxed group-[.is-user]:rounded-2xl group-[.is-user]:bg-devdeck-raised group-[.is-user]:px-4 group-[.is-user]:py-2.5'
            : 'w-full max-w-full',
        )}
      >
        {isUser ? (
          <>
            {attachments.length > 0 ? (
              <div className="mb-2 flex flex-wrap justify-end gap-1.5">
                {attachments.map((attachment) => (
                  <AttachmentThumbnail key={attachment.id} machine={machine} attachment={attachment} />
                ))}
              </div>
            ) : null}
            {/* An image with no caption is a real, complete message — the
                "…" empty-placeholder only applies when there is truly
                nothing, text or attachment, to show. */}
            {visibleText || attachments.length === 0 ? (
              <div className="break-words whitespace-pre-wrap">{visibleText || '…'}</div>
            ) : null}
            {contexts.length > 0 ? (
              <TerminalContextDisclosure contexts={contexts} expanded={contextsExpanded} onToggle={onToggleContexts} />
            ) : null}
          </>
        ) : (
          <MessageResponse className="chat-md" components={CODE_FENCE_COMPONENTS}>
            {withHardBreaks(item.text) || '…'}
          </MessageResponse>
        )}
      </MessageContent>
      {isUser
        ? contexts.length > 0
          ? <MessageFooter text={copyText} stamp={stamp} />
          : null
        : <MessageFooter text={item.text} stamp={stamp} />}
    </Message>
  )
}

/**
 * The collapsed "N terminal contexts" row under a user message whose text
 * carried one or more `terminalContext` chips (design spec C3, "Display must
 * strip it") — `MessageRow` already stripped the block out of `visibleText`
 * above via T12's `extractTrailingTerminalContexts`; this is where its
 * entries actually render. Mirrors `ToolGroupRow`'s own
 * Task/TaskTrigger/TaskContent disclosure for a run of tool calls, both for
 * visual consistency and because it's already proven to work under this
 * suite's jsdom setup.
 */
function TerminalContextDisclosure({
  contexts,
  expanded,
  onToggle,
}: {
  contexts: TerminalContextEntry[]
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <Task open={expanded} onOpenChange={onToggle} className="mt-2 w-full max-w-full self-end">
      <TaskTrigger title={`${contexts.length} terminal ${contexts.length === 1 ? 'context' : 'contexts'}`} />
      <TaskContent>
        {contexts.map((entry, index) => (
          <pre key={`${entry.destination}-${index}`} className="whitespace-pre-wrap text-left text-[12px] text-devdeck-fg-2">
            {entry.text}
          </pre>
        ))}
      </TaskContent>
    </Task>
  )
}

/**
 * The one row under an agent message: the turn's stamp, then copy.
 *
 * These used to be two stacked blocks — `MessageActions` inside the message and
 * a sibling `TurnStamp` in the column outside it — which left the copy glyph
 * sitting on a line of its own above the time. They are the same kind of thing
 * (what you can do with this turn, and what it cost), so they share a row.
 *
 * The stamp leads. With the button first it reserved 20px of width whether or
 * not it was visible, so this stamp started 20px right of the one a turn ending
 * on a tool group renders — two readings of the same field, on two different
 * left edges, in the same transcript. Nothing about the button needs to come
 * first, and this way every stamp in the thread sits on the column's own edge.
 *
 * Only the copy button is hover-gated; the stamp stays visible, because it is
 * information rather than an affordance and a transcript you have to hover to
 * read the timings of is not one.
 */
function MessageFooter({ text, stamp }: { text: string; stamp?: ReactNode }) {
  const canCopy = text.length > 0
  if (!canCopy && stamp === undefined) return null

  const copy = canCopy ? (
    <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <MessageAction
        className="size-5 text-devdeck-fg-2 hover:text-devdeck-fg"
        label="Copy message"
        onClick={() => void navigator.clipboard?.writeText(text)}
      >
        <Copy size={12} aria-hidden="true" />
      </MessageAction>
    </MessageActions>
  ) : null

  // ── The unsettled turn's footer takes no space ──
  //
  // A stamp is real, permanently visible content and earns its own row. With
  // no stamp — every reply in a turn that has not settled, which is every
  // reply for as long as the agent is still working — the row's only occupant
  // is a button that is transparent until hover, and it was still reserving
  // 24px of height plus the `Message`'s own 8px gap above it. Stacked on the
  // transcript's 20px entry gap, that put ~52px of blank between an agent's
  // sentence and the tool call it was announcing, which read as the thread
  // having lost its place.
  //
  // Positioned instead of hidden, so the affordance survives: `-bottom-5` is
  // exactly the entry gap below the message box, and the button is sized to
  // match (`size-5` = 20px = `gap-5`), so on hover it lands cleanly in that
  // gap rather than over the next entry. Requires `relative` on `Message` —
  // see `MessageRow`.
  if (stamp === undefined) {
    return <div className="absolute -bottom-5 -left-1 flex items-center">{copy}</div>
  }

  return (
    <div className="flex min-h-5 items-center gap-1">
      {stamp}
      {copy}
    </div>
  )
}

/** The reasoning disclosure's label — `✦ Worked for 11s ›`, the shape t3code
 *  uses. The vendored default is a brain glyph plus "Thought for N seconds";
 *  this replaces the whole thing rather than restyling it, because the glyph
 *  is a direct child of the trigger and there is no prop that removes it.
 *
 *  The glyph is back, at the work log's own 14px, for one reason: without it
 *  this row opened at the column's left edge while every tool row beside it
 *  opened 22px further in, so the transcript's left margin stepped in and out
 *  once per row. What state the block is in is still carried by the LABEL
 *  (`Working…` shimmering vs `Worked for 11s`), which is the opposite of a tool
 *  row — there the glyph carries the state and the label is fixed — because a
 *  reasoning block has one shape of outcome and a tool call has four.
 *
 *  The trailing spacer is `ToolCompactHeader`'s: it keeps the chevron next to
 *  the text it belongs to instead of pinned to the far right of an otherwise
 *  empty row. */
function ReasoningLabel() {
  const { isStreaming, isOpen, duration } = useReasoning()

  return (
    <>
      <ActivityGlyph className={cn('text-devdeck-dim-pane', isStreaming && 'animate-pulse text-devdeck-accent')}>
        <Sparkles aria-hidden="true" />
      </ActivityGlyph>
      {isStreaming ? (
        <Shimmer as="span" duration={1.4}>
          Working…
        </Shimmer>
      ) : (
        <span>{duration === undefined ? 'Worked for a few seconds' : `Worked for ${duration}s`}</span>
      )}
      <ChevronRight aria-hidden="true" className={cn('size-3.5 flex-none transition-transform', isOpen && 'rotate-90')} />
      <span className="flex-1" />
    </>
  )
}

/** How long the agent spent on this reasoning block, from the orchestration
 *  event's own timestamps. Handed to `Reasoning` so a REPLAYED thread stamps
 *  the same duration the live one did — the vendored component can only time
 *  a stream it watched itself, so on reconnect every block read "a few
 *  seconds". `undefined` for a block that never advanced, which is what makes
 *  the label fall back rather than claim "0s". */
function reasoningDuration(item: ChatItem): number | undefined {
  if (item.createdAt === undefined) return undefined
  const seconds = Math.round(((item.updatedAt ?? item.createdAt) - item.createdAt) / 1000)
  return seconds > 0 ? seconds : undefined
}

function ReasoningRow({ entry, streaming }: { entry: ReasoningEntry; streaming: boolean }) {
  return (
    <Reasoning
      className="mb-0 w-full max-w-full self-stretch"
      duration={reasoningDuration(entry.item)}
      isStreaming={streaming}
      defaultOpen={false}
    >
      <ReasoningTrigger
        className={cn(ACTIVITY_ROW, ACTIVITY_ROW_INTERACTIVE, 'text-devdeck-fg-2 hover:text-devdeck-fg')}
      >
        <ReasoningLabel />
      </ReasoningTrigger>
      {/* Reasoning is prose whose line breaks matter even more than an answer's
          — same treatment, same reason as MessageRow's assistant branch.
          Indented to `ACTIVITY_GUTTER` so the rule hangs under the label rather
          than under the glyph, and given the row's own 4px of air rather than
          12px: the expanded body belongs to the row above it, and a gap wide
          enough to read as a new entry said otherwise. */}
      <ReasoningContent
        className={cn(
          'chat-md mt-1 mb-1 border-l border-devdeck-hairline pl-3 text-[13px] text-devdeck-fg-2',
          ACTIVITY_GUTTER,
        )}
      >
        {withHardBreaks(entry.item.text)}
      </ReasoningContent>
    </Reasoning>
  )
}

/** One tool call, as a single dense line: status glyph, tool name, and the
 *  call's own primary argument (`toolSummary`) in mono behind it.
 *
 *  The card `Tool` ships by default — a border, `mb-4`, and a `p-3` header
 *  carrying a status pill — is stripped here. A turn that reads twenty files
 *  produced twenty bordered boxes, which is the transcript's whole height spent
 *  on chrome for its least interesting content. Rows now stack directly against
 *  each other (`ToolGroupRow` sets no gap), so a run of calls reads as one block
 *  of work rather than as twenty separate announcements.
 *
 *  `ToolInput` is rendered only when arguments actually arrived; `ToolOutput`
 *  never is — the Claude provider does not parse `tool_result`, so this app has
 *  no tool output to show.
 *
 *  With no arguments there is nothing to disclose, and the header is
 *  unconditionally the collapsible's trigger — so the row is disabled rather
 *  than offering a chevron that expands to nothing. That is every call while it
 *  is still in flight, plus any zero-argument call. */
function ToolRow({ item }: { item: ChatItem }) {
  // Two halves now, not one — see `eventReducer.ts`'s `toolDetailParts`. A
  // claude call has arguments and never a result; a pi call has both. The row
  // is only inert when it has neither.
  const resultText = toolResultText(item.output)
  const hasInput = item.input !== undefined
  const hasOutput = item.output !== undefined
  const disclosable = hasInput || hasOutput

  return (
    <Tool className="mb-0 rounded-md border-0" disabled={!disclosable}>
      {/* Radix marks a disabled collapsible's trigger with `data-disabled`;
          hiding its chevron there is what stops the row reading as expandable.
          The chevron is the trigger's only direct `svg` child. */}
      <ToolCompactHeader
        className={cn(
          ACTIVITY_ROW,
          ACTIVITY_ROW_INTERACTIVE,
          'data-[disabled]:cursor-default data-[disabled]:hover:bg-transparent [&[data-disabled]>svg]:invisible',
        )}
        name={toolDisplayName(item.toolName)}
        state={toolUIState(item.status)}
        summary={toolSummary(item.input)}
      />
      {disclosable ? (
        // The vendored `ToolInput` is deliberately not used: it prefixes the
        // arguments with an uppercase "PARAMETERS" heading and wraps them in
        // `bg-muted/50` — a shadcn token, not a DevDeck one. The row above
        // already names the tool, so the heading labels the obvious.
        //
        // Indented to `ACTIVITY_GUTTER`, so an expanded call's arguments start
        // under the tool's NAME rather than under its status glyph — the same
        // rule the expanded reasoning body follows. `px-0` is deliberate:
        // `ToolContent`'s vendored `p-4` would otherwise leave 16px of
        // asymmetric padding on the right of an already-indented block.
        <ToolContent className={cn('space-y-2 overflow-hidden px-0 pt-1 pb-2', ACTIVITY_GUTTER)}>
          {hasInput ? (
            <CodeBlock className={TOOL_DETAIL_CODE} code={JSON.stringify(item.input, null, 2)} language="json" />
          ) : null}
          {hasOutput ? (
            <div className="space-y-1">
              {/* Captioned only when there is something above it to tell it
                  apart from — a result on its own needs no label. */}
              {hasInput ? (
                <div className="px-0.5 text-[10.5px] tracking-wide text-devdeck-dim-pane uppercase">Result</div>
              ) : null}
              {/* Plain text when the provider's envelope unwraps to plain
                  text, JSON only as the fallback for a shape `toolResultText`
                  does not recognise. */}
              {resultText === undefined ? (
                <CodeBlock className={TOOL_DETAIL_CODE} code={JSON.stringify(item.output, null, 2)} language="json" />
              ) : (
                <pre className="max-h-72 overflow-auto rounded-md border border-devdeck-hairline bg-devdeck-raised px-3 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-devdeck-fg-2">
                  {resultText}
                </pre>
              )}
            </div>
          ) : null}
        </ToolContent>
      ) : null}
    </Tool>
  )
}

/** A run of consecutive calls. Everything but the newest folds behind a
 *  disclosure — a turn that reads twenty files must not push the prose off
 *  screen.
 *
 *  The fold's own row is built by hand rather than left to `TaskTrigger`'s
 *  default, which renders a 16px magnifier and `text-sm` inside a plain `div`:
 *  wrong glyph size for this column, wrong left edge, and not reachable as a
 *  button. Passing `TaskTrigger` explicit children replaces all of it — the
 *  `asChild` trigger hands its props to whatever element it is given, so this
 *  is a real `<button>` with the work log's shared shell on it. */
function ToolGroupRow({ entry, expanded, onToggle }: { entry: ToolGroupEntry; expanded: boolean; onToggle: () => void }) {
  const { visible, hidden } = collapseWorkLog(entry.items)
  const foldLabel = `${hidden.length} earlier ${hidden.length === 1 ? 'step' : 'steps'}`
  return (
    <div className="flex w-full flex-col">
      {hidden.length > 0 ? (
        <Task open={expanded} onOpenChange={onToggle} className="w-full">
          <TaskTrigger title={foldLabel}>
            <button
              type="button"
              className={cn(
                ACTIVITY_ROW,
                ACTIVITY_ROW_INTERACTIVE,
                'text-devdeck-fg-2 hover:text-devdeck-fg',
              )}
            >
              <ActivityGlyph className="text-devdeck-dim-pane">
                <History aria-hidden="true" />
              </ActivityGlyph>
              <span>{foldLabel}</span>
              <ChevronRight
                aria-hidden="true"
                className={cn('size-3.5 flex-none transition-transform', expanded && 'rotate-90')}
              />
              <span className="flex-1" />
            </button>
          </TaskTrigger>
          {/* No indent and no gap: the rows this unfolds ARE tool rows, and they
              have to land on exactly the left edge the visible one below them
              sits on. `TaskContent`'s vendored `mt-4 border-l-2 pl-4` wrapper
              made the same call look like two different things depending on
              whether it happened to be the newest — hence `TaskCompactContent`. */}
          <TaskCompactContent>
            {hidden.map((item) => (
              <ToolRow key={item.id} item={item} />
            ))}
          </TaskCompactContent>
        </Task>
      ) : null}
      {visible.map((item) => (
        <ToolRow key={item.id} item={item} />
      ))}
    </div>
  )
}

/**
 * `21:50:28 • 8s · 12.4k tokens · 38 tok/s`.
 *
 * `inline` drops the block's own alignment and top padding: the same stamp is
 * rendered either as its own row (a turn that ended on a tool group) or inside
 * an agent message's footer next to the copy button, and in the second case the
 * flex row it joins owns the alignment.
 *
 * The token half is absent whenever the provider reported no usage — see
 * `formatTurnTokens`. `title` carries the breakdown the compact form drops, so
 * "38 tok/s" is traceable to a number rather than being a bare claim.
 */
function TurnStamp({
  startedAt,
  completedAt,
  item,
  inline = false,
}: {
  startedAt: number
  completedAt: number
  item?: ChatItem
  inline?: boolean
}) {
  const tokens = formatTurnTokens(item?.turnTokens, item?.turnOutputTokens, startedAt, completedAt)
  // Which agent and model actually ran this turn. Last in the row because it
  // is the least volatile part — the time and the cost are what you scan, and
  // this answers the follow-up question once something looks wrong.
  const engine = formatTurnEngine(item?.turnAgent, item?.turnModel)
  const title =
    item?.turnTokens === undefined
      ? undefined
      : `${item.turnTokens.toLocaleString()} tokens this turn` +
        (item.turnOutputTokens ? `, ${item.turnOutputTokens.toLocaleString()} of them generated` : '')
  return (
    <div className={cn('text-[11px] text-devdeck-dim-pane', !inline && 'self-start pt-0.5')} title={title}>
      {formatTurnStamp(startedAt, completedAt)}
      {tokens ? ` · ${tokens}` : ''}
      {engine ? ` · ${engine}` : ''}
    </div>
  )
}

/** Ticks once a second while the agent works, so `WorkingRow` can count up.
 *  `since` is the last event's wall clock, not a render-time reading, so the
 *  count survives a re-render and is correct after a reconnect replay. */
function useElapsedSeconds(since: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (since === undefined) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [since])

  if (since === undefined) return null
  return Math.max(0, Math.round((now - since) / 1000))
}

/** `••• Working for 5s` — the answer to "is it still going, or has it hung?".
 *
 *  Rendered for the WHOLE of a running turn, not just the silent gap before the
 *  first token. It used to be suppressed as soon as anything else moved on
 *  screen, on the theory that streaming text is its own progress indicator. It
 *  isn't: text stops between a tool call and the next thought, a tool row shows
 *  no elapsed time, and a collapsed work log shows nothing at all — so the one
 *  question a running turn has to answer went unanswered for most of that
 *  turn's duration. It is the last thing in the column, so it reads as the live
 *  edge of the transcript rather than as a competing claim about some entry
 *  above it.
 *
 *  `role="status"` (not an alert): a screen reader should hear it when it
 *  appears without having the reading of the transcript interrupted every
 *  second the number ticks. */
function WorkingRow({ since }: { since: number | undefined }) {
  const seconds = useElapsedSeconds(since)

  return (
    <div role="status" className={cn(ACTIVITY_ROW, 'text-devdeck-fg-2')}>
      {/* The dots shrank from 5px to 3px so the whole cluster (3×3 + 2×2 = 13px)
          fits the work log's 14px glyph slot. At their old size they were 23px
          wide, which pushed this row's label 9px right of every other row's — the
          live edge of the transcript was the one line that did not line up. */}
      <ActivityGlyph>
        <span aria-hidden="true" className="flex items-center gap-[2px]">
          <span className="size-[3px] animate-dot-pulse rounded-full bg-current" />
          <span className="size-[3px] animate-dot-pulse rounded-full bg-current [animation-delay:0.22s]" />
          <span className="size-[3px] animate-dot-pulse rounded-full bg-current [animation-delay:0.44s]" />
        </span>
      </ActivityGlyph>
      {seconds === null ? 'Working…' : `Working for ${seconds}s`}
    </div>
  )
}

/**
 * When the turn currently running began — the last user message's own timestamp,
 * which is what "Working for 42s" has to count from.
 *
 * Deliberately NOT the newest item's `updatedAt`: that advances on every
 * streamed token and every tool status change, so counting from it reset the
 * timer to zero continuously and the row read "Working for 0s" for the entire
 * turn. Falls back to the newest item only when the thread holds no user turn at
 * all (a replayed thread whose head was trimmed), and to `undefined` when it is
 * empty — which is what makes the label read "Working…" rather than claim a
 * duration it cannot know.
 */
function runningTurnStartedAt(items: ChatItem[]): number | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const candidate = items[i]
    if (candidate.kind === 'user' && candidate.createdAt !== undefined) return candidate.createdAt
  }
  const newest = items[items.length - 1]
  return newest?.createdAt
}

export function MessagesTimeline({ view, machine = NO_MACHINE }: MessagesTimelineProps) {
  const entries = buildTimeline(view)
  const spans = turnSpans(entries)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const lastIndex = entries.length - 1

  // Whenever the thread is running — see `WorkingRow`. The one exception is a
  // turn that ended in an error: the reducer can leave `status` at 'running'
  // there, and "provider unreachable" sitting above a live "Working for 90s" is
  // two contradictory claims, of which only the error is true.
  const lastItem = view.items[view.items.length - 1]
  const showWorking = view.status === 'running' && lastItem?.kind !== 'error'

  return (
    // ── Two gaps, not one ──
    //
    // The column used to be `gap-5`: one 20px seam between every pair of
    // entries, whatever they were. But a tool group already stacks its own rows
    // flush against each other, so an eight-call turn read as one tight block
    // until a reasoning block landed in the middle of it — at which point the
    // same run of work grew a 20px seam on either side of the thought and
    // nowhere else. That is the "random" spacing: not one gap chosen badly, but
    // two different rhythms (0px inside a group, 20px between entries) applied
    // to rows that look identical.
    //
    // So the gap is now a property of the BOUNDARY rather than of the container.
    // Work rows — tool calls, reasoning, the fold, the live working row — are
    // one list and close up, matching the rhythm a group already had. Prose — a
    // message, a plan card, an error — is a paragraph break and keeps the 20px.
    <div className={cn(COLUMN, 'gap-0 px-5 py-6 text-[14px] text-devdeck-fg')}>
      {entries.map((entry, index) => {
        const key = entryKey(entry, index)
        const flush = index > 0 && isWorkEntry(entry) && isWorkEntry(entries[index - 1])

        // A turn stamp renders on the turn's last entry, but only once that
        // turn is settled. The trailing turn is settled when the thread is
        // neither running nor blocked waiting on the user (a turn parked on an
        // approval has not finished); an earlier turn always is, because the
        // next turn's user message already arrived after it.
        const span = spans.find((s) => s.lastEntryIndex === index)
        const isTrailingTurn = span?.lastEntryIndex === lastIndex
        const inFlight = view.status === 'running' || view.status === 'waiting'
        const settled = span !== undefined && (!isTrailingTurn || !inFlight)
        const startedAt = span ? entryCreatedAt(entries[span.firstEntryIndex]) : undefined
        // The END of the turn, not the creation of its last entry — see
        // `entryCompletedAt`. A streamed reply's createdAt is its
        // time-to-first-token, which is not when the turn finished.
        const completedAt = span ? entryCompletedAt(entries[span.lastEntryIndex]) : undefined

        const showStamp = settled && startedAt !== undefined && completedAt !== undefined
        // A turn that ends on an agent message hands its stamp to that
        // message's footer, so the copy button and the timings share one row.
        // A turn ending on a tool group or reasoning block has no footer to
        // join and keeps the stamp as a row of its own.
        const inlineStamp = showStamp && entry.kind === 'message' && entry.item.kind !== 'error'
        const stampNode = showStamp ? (
          <TurnStamp
            startedAt={startedAt}
            completedAt={completedAt}
            item={entry.kind === 'message' ? entry.item : undefined}
            inline={inlineStamp}
          />
        ) : null

        // What this turn wrote, from its own tool calls — see `changedFiles.ts`.
        // On the turn's LAST entry and only once it has settled, for the same
        // reason the stamp is: a turn still running has not finished writing,
        // and a card whose count climbs while you read it invites a review of a
        // file list that is not final yet.
        const changed = settled && span ? changedFilesOf(turnItems(entries, span)) : []

        let node: ReactNode
        if (entry.kind === 'message') {
          const contextsKey = `terminal-context:${entry.item.id}`
          node =
            entry.item.kind === 'error' ? (
              <ErrorRow item={entry.item} />
            ) : entry.item.kind === 'notice' ? (
              <NoticeRow item={entry.item} />
            ) : (
              <MessageRow
                item={entry.item}
                stamp={inlineStamp ? stampNode : undefined}
                machine={machine}
                contextsExpanded={expanded.has(contextsKey)}
                onToggleContexts={() => toggle(contextsKey)}
              />
            )
        } else if (entry.kind === 'reasoning') {
          node = <ReasoningRow entry={entry} streaming={view.status === 'running' && index === lastIndex} />
        } else if (entry.kind === 'plan') {
          node = <ProposedPlanCard markdown={entry.item.text} />
        } else {
          const groupKey = `tool-group:${key}`
          node = <ToolGroupRow entry={entry} expanded={expanded.has(groupKey)} onToggle={() => toggle(groupKey)} />
        }

        // A flex column of its own, so `self-start` / `ml-auto` / `self-stretch`
        // on the nodes below still resolve the way they did as direct children
        // of the transcript. Replaces a `Fragment` purely because the boundary
        // gap has to hang on something.
        return (
          <div key={key} className={cn('flex w-full flex-col', index > 0 && !flush && 'mt-5')}>
            {node}
            {changed.length > 0 ? (
              <div className="mt-3">
                <ChangedFilesCard files={changed} />
              </div>
            ) : null}
            {/* The stamp belongs to the entry above it, so it gets the row's own
                air rather than the 20px that would read as a new entry. */}
            {inlineStamp || stampNode === null ? null : <div className="mt-1.5">{stampNode}</div>}
          </div>
        )
      })}

      {/* Flush against a work log it is the next step of; a paragraph break away
          from prose it is not. Same rule as every boundary above. */}
      {showWorking ? (
        <div className={cn('flex w-full flex-col', !isWorkEntry(entries[lastIndex]) && entries.length > 0 && 'mt-5')}>
          <WorkingRow since={runningTurnStartedAt(view.items)} />
        </div>
      ) : null}

      {view.hasGap ? (
        <div className="mt-5 flex items-center gap-1.5 self-center rounded-full border border-devdeck-hairline bg-devdeck-raised px-2.5 py-1 text-[11.5px] text-devdeck-fg-2">
          <AlertTriangle size={11} className="text-devdeck-wait" />
          Some updates may be missing from this thread
        </div>
      ) : null}
    </div>
  )
}
