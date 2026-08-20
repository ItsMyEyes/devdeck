/**
 * Chat input, t3code shell: a TipTap prompt editor and the control row live
 * inside one frame/surface pair. Enter sends,
 * Shift+Enter inserts a newline — that contract now belongs to
 * `ComposerPromptEditor`'s own keymap (see that file's doc comment), not this
 * one; sending is never disabled by `status === 'running'` — the decider
 * explicitly allows a follow-up message to "steer" an in-flight turn (see the
 * design note on `CmdThreadTurnStart` in
 * `backend/internal/agentcore/orchestration/engine.go`'s `Decide`), so gating
 * Send on idle would silently reject something the backend already supports.
 *
 * Two placements, one component. `variant="docked"` is the composer a live
 * thread scrolls above; `variant="hero"` is the same box parked in the middle
 * of an empty thread under "What should we build in …?" — no top border,
 * nothing to divide it from the heading it belongs to. Both share the
 * transcript's `max-w-3xl` measure so the box never sits wider than the
 * messages it produces.
 *
 * There is no worktree/branch strip under the box any more. It restated what
 * the pane's own header and tab already say, on the one line of every chat
 * pane that is closest to the thing the user is actually typing into.
 *
 * The mode/model pills come from `ComposerControls`, which owns their
 * options and dispatches the real commands. The row is rendered twice —
 * once inline (shown above the `@2xl/composer` container breakpoint, which is
 * measured from the row's own laid-out width — see the footer) and
 * once inside the "More controls" overflow popup (shown below it) —
 * mirroring `BrowserToolbar.tsx`'s existing pattern for the same problem:
 * wrapping must be structurally impossible, not merely unlikely, so the
 * escape hatch is a second real copy of the row rather than JS-measured
 * hiding. Four `Select`s in a `flex-wrap` row is what this replaced, and
 * it stacked into four full-width rows in any real pane width.
 *
 * The shell itself is t3code's own structure (design spec
 * `2026-08-14-composer-shell-tiptap-editor-design.md` §1), not the vendored
 * AI Elements `PromptInput`: a plain `<form>` around a `p-px` "frame" div
 * (reserved, unstyled here, for a future gradient-ring state — see the
 * design spec) wrapping a real "surface" div that we style directly —
 * border, background, radius, focus ring, all ours, no descendant-selector
 * fight. The old `BOX` constant existed only because the vendored
 * `InputGroup` hardcoded its own `rounded-md`/`border-input`/`dark:bg-input/30`/
 * `shadow-xs` and `PromptInput` spread our className onto the `<form>` only,
 * leaving the box the user actually saw out of reach except through
 * `[&>[data-slot=input-group]]:…` overrides. That box is gone: this shell
 * owns its own DOM from the `<form>` down to the surface, so there is
 * nothing left to re-point.
 *
 * `PromptInputButton`/`PromptInputSubmit` stay — the box-fighting problem
 * was `InputGroup`'s hardcoded container styling, not these; they're kept
 * standalone (outside any `InputGroup`/`PromptInput` context) purely for
 * their button chrome and status-driven icon swap, same as before.
 *
 * The `@container/composer` dual render of `ComposerControls` stays, sized
 * off the whole form (not just the control row) — note that a container query
 * measures the form's CONTENT box, so the stop is 40px of horizontal padding
 * short of the form's border-box width. The pills also stay on
 * `@base-ui/react`, because they carry `useNativeOverlayBlocker` for the
 * Tauri webview.
 */
import { useEffect, useRef, useState } from 'react'
import type {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  FormEvent,
  MouseEvent as ReactMouseEvent,
} from 'react'
import { ArrowUp, MoreHorizontal, Paperclip, Square } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { PromptInputButton, PromptInputSubmit } from '@/components/ai-elements/prompt-input'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { promptChatStatus } from '@/features/agent-chat/adapter'
import { composerControlClassName } from '@/features/agent-chat/ComposerControl'
import { ComposerAttachments } from '@/features/agent-chat/ComposerAttachments'
import type { AgentAttachmentRef, ComposerAttachmentsHandle } from '@/features/agent-chat/ComposerAttachments'
import { ComposerBannerStack } from '@/features/agent-chat/ComposerBannerStack'
import type { ComposerBannerStackItem } from '@/features/agent-chat/ComposerBannerStack'
import { ComposerControls } from '@/features/agent-chat/ComposerControls'
import type { ComposerControlsProps } from '@/features/agent-chat/ComposerControls'
import { ComposerPendingApprovalPanel } from '@/features/agent-chat/ComposerPendingApprovalPanel'
import { ComposerPendingUserInputPanel } from '@/features/agent-chat/ComposerPendingUserInputPanel'
import { ComposerPlanFollowUpBanner } from '@/features/agent-chat/ComposerPlanFollowUpBanner'
import { ComposerPromptEditor } from '@/features/agent-chat/ComposerPromptEditor'
import type { ComposerPromptEditorHandle } from '@/features/agent-chat/ComposerPromptEditor'
import type { MentionSource } from '@/features/agent-chat/composerMention'
import { ComposerStashBadge } from '@/features/agent-chat/ComposerStashBadge'
import { ComposerStashMenu } from '@/features/agent-chat/ComposerStashMenu'
import { composerTerminalContextChip, serializeComposerDoc } from '@/features/agent-chat/composerSerialize'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  togglePendingUserInputOptionSelection,
} from '@/features/agent-chat/pendingUserInput'
import type { PendingUserInputDraftAnswer } from '@/features/agent-chat/pendingUserInput'
import { resolvePlanFollowUpSubmission } from '@/features/agent-chat/planMarkdown'
import type { PlanFollowUpSubmission } from '@/features/agent-chat/planMarkdown'
import { buildTerminalContextBlock } from '@/features/agent-chat/terminalContext'
import type { TerminalContextCapture } from '@/features/agent-chat/terminalContext'
import type { AgentThreadView, ChatItem, PendingApproval, PendingUserInput } from '@/features/agent-chat/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { Machine } from '@/store/types'

/** t3code's own `COMPOSER_PERSIST_DEBOUNCE_MS` (`composerDraftStore.ts:67`,
 *  design spec §2): a keystroke's mirror-write re-serializes zustand's whole
 *  persisted blob, so this is a trailing debounce, not a per-character
 *  write. */
const COMPOSER_DRAFT_DEBOUNCE_MS = 300

/**
 * Composer-context-attachments plan, T15 (C3) — the bridge from
 * `ExpandedTerminal.tsx`'s "Send to chat" affordance to the composer that
 * should receive it. The design spec (and this plan's own "Then implement"
 * prose) describes this as `pendingTerminalContext` state passed down
 * `ExpandedTerminal` → `AgentChatPane` → `ChatComposer`, but `AgentChatPane.tsx`
 * sits between the two and belongs to T11's file ownership, not this task's
 * — it cannot grow a new ref-forwarding prop here. A module-level registry,
 * keyed by `threadKey` (the identifier every layer already agrees on, since
 * `AgentChatPane` already forwards it to `ChatComposer` unchanged), reaches
 * the same target with no new prop on the file in between. Mirrors
 * `features/ssh/sshTerminalRegistry.ts`'s own module-level bridge between
 * two components with no ref path between them.
 */
interface TerminalContextChatTarget {
  insert: (value: string, label: string, text: string) => void
}
const terminalContextChatTargets = new Map<string, TerminalContextChatTarget>()
/** A capture that arrived before its target thread's `ChatComposer` had
 *  mounted — e.g. `ExpandedTerminal` just opened a brand-new chat pane in
 *  the very click that captured the selection, so React has not yet
 *  committed that mount by the time `insertTerminalContext` runs
 *  synchronously afterward. Applied, in arrival order, the moment that
 *  threadKey registers below. */
const pendingTerminalContextInserts = new Map<string, { value: string; label: string; text: string }[]>()

/**
 * `ExpandedTerminal.tsx`'s "Send to chat" bridge calls this once it has
 * resolved the target chat pane and turned a captured terminal selection
 * into a chip's `value`/`label` (`'<sessionKey>/L<start>-L<end>'`, per T1's
 * `composerSerialize.ts` contract) — see this file's header comment on why
 * a registry, not a ref prop reaching through `AgentChatPane`. Silently
 * queues when no `ChatComposer` for `threadKey` is mounted yet.
 */
export function insertTerminalContext(threadKey: string, value: string, label: string, text: string): void {
  const target = terminalContextChatTargets.get(threadKey)
  if (target) {
    target.insert(value, label, text)
    return
  }
  const queued = pendingTerminalContextInserts.get(threadKey) ?? []
  queued.push({ value, label, text })
  pendingTerminalContextInserts.set(threadKey, queued)
}

/** Every `(terminal:...)` markdown-link destination in a serialized message,
 *  in the order it appears — document order, since `serializeComposerDoc`
 *  (T1) preserves it. A terminal destination never contains a literal `(`
 *  or `)` (`encodeMarkdownLinkDestination` percent-encodes both), so this
 *  cannot stop early on an embedded paren. */
const TERMINAL_LINK_DESTINATION_PATTERN = /\((terminal:[^)]*)\)/g

/**
 * Reads the `terminal:` destinations out of the already-serialized message
 * text (`ComposerPromptEditor`'s `onUpdate` already ran it through
 * `serializeComposerDoc` — see that file's `onChange` — so `text` at submit
 * time already IS that serialized string), looks each up in this submit's
 * capture map, and appends T12's `<terminal_context>` block. A destination
 * with no captured entry is skipped rather than crashing the send — today
 * that never happens, since `insertTerminalContext` above is the only
 * producer of a `terminalContext` chip and it always populates the map
 * first.
 *
 * Working from the serialized string rather than `editor.getJSON()` (as the
 * design doc's prose describes) is this task's one adaptation for file
 * ownership: `ComposerPromptEditorHandle` (T14, a file this task does not
 * own) exposes `insertChip` only, no read-back of the live document. Since
 * `text` already equals `serializeComposerDoc`'s output, this reads the same
 * doc-order destinations from the same serialization — just via its string
 * form instead of its JSON form.
 */
function appendTerminalContexts(text: string, captures: ReadonlyMap<string, TerminalContextCapture>): string {
  const contexts: TerminalContextCapture[] = []
  for (const match of text.matchAll(TERMINAL_LINK_DESTINATION_PATTERN)) {
    const capture = captures.get(match[1]!)
    if (capture) contexts.push(capture)
  }
  return buildTerminalContextBlock(text, contexts)
}

/** Stands in for `machine`/`worktreeId` when a caller has neither — every
 *  real mount (`AgentChatPane`) has both, but `ChatComposer.test.tsx` mounts
 *  this component directly with no worktree context at all. `@` mentions
 *  simply never fire in that case (nothing types `@` there), so an empty,
 *  never-dispatched machine is enough to satisfy `ComposerPromptEditor`'s
 *  required props without forcing every caller to invent one. */
const NO_MACHINE: Machine = { id: '', name: '', url: '', key: '', isLocal: false, signingPublicKey: '' }

export interface ChatComposerProps {
  status: AgentThreadView['status']
  /** Fires on submit — Enter, the action button, or the plan follow-up
   *  bypass (see `onPlanFollowUp` below, which does not go through this).
   *  `attachments` is `ComposerAttachments`' `attachments()` at the moment of
   *  submit: only uploads that had finished by then, mapped to the wire
   *  shape (`{id,kind,mime,name}`) — never omitted, an empty array when
   *  nothing was attached (design spec §"The send contract widens by one
   *  argument"). */
  onSend: (text: string, attachments: AgentAttachmentRef[]) => void
  onAbort: () => void
  /** Threaded straight into `ComposerPromptEditor`'s `@` file mention (design
   *  spec §4). Optional because not every caller has a worktree — see
   *  `NO_MACHINE`'s doc comment. */
  machine?: Machine
  worktreeId?: string
  /** Plan T13 — overrides the `@` mention menu's data source, e.g.
   *  `sshMentionSource(connectionId)` for an SSH thread's chat panel.
   *  Optional; when absent, `ComposerPromptEditor` falls back to
   *  `worktreeMentionSource(machine, worktreeId)` exactly as before this
   *  prop existed, so no existing caller needs to change. Not wired by this
   *  task — a later task passes the SSH source in from the SSH chat pane. */
  mentionSource?: MentionSource
  /** `'docked'` (default) pins the composer under a live transcript;
   *  `'hero'` centres it in an empty thread. See the file's doc comment. */
  variant?: 'docked' | 'hero'
  /** Everything `ComposerControls` needs except `variant`, which this
   *  component sets per copy of the row. Passed as one object rather than
   *  eight flat props so adding a control doesn't ripple through
   *  `AgentChatPane` → `ChatComposer` → `ComposerControls`. */
  controls: Omit<ComposerControlsProps, 'variant'>
  /** Open `AskUserQuestion` requests, oldest first — `AgentThreadView.pendingUserInputs`
   *  passed straight through by `AgentChatPane`. Optional (default `[]`) so the
   *  many pre-existing renders in `ChatComposer.test.tsx` that predate this prop
   *  don't need updating; the real mount always supplies it. */
  pendingUserInputs?: PendingUserInput[]
  /** Dispatches `thread.user-input.respond` (T8's `useAgentChatSocket`).
   *  Optional for the same reason as `pendingUserInputs`. */
  onRespondToUserInput?: (requestId: string, answers: Record<string, unknown>) => void
  /** Open approval (`can_use_tool`) requests, oldest first —
   *  `AgentThreadView.pendingApprovals` passed straight through by
   *  `AgentChatPane`. Optional (default `[]`) for the same reason as
   *  `pendingUserInputs`. */
  pendingApprovals?: PendingApproval[]
  /** Dispatches `thread.approval.respond` (T17's `useAgentChatSocket`).
   *  Optional for the same reason as `onRespondToUserInput`. */
  onRespondToApproval?: (requestId: string, decision: string) => void
  /** The plan on the table for this thread — `AgentChatPane`'s
   *  `latestProposedPlan(view.items)` (plan T7), passed straight through.
   *  `null` (default) when there is none, so every pre-existing render in
   *  `ChatComposer.test.tsx` (none of which know about plans) needs no
   *  change. Combined with `controls.interactionMode` and `status`, this is
   *  the same three-way follow-up condition `ComposerPlanFollowUpBanner`
   *  (T10) applies to itself — computed here too because the action button
   *  below needs it to decide between Send/Stop and Implement/Refine. */
  plan?: ChatItem | null
  /** Fires when the follow-up action button is pressed while the follow-up
   *  condition holds (design spec §7). The resolved `PlanFollowUpSubmission`
   *  (T8's `resolvePlanFollowUpSubmission`) carries everything the caller
   *  needs: `text` to send and the `mode` the composer must be in afterward
   *  — `AgentChatPane` is the one place that already owns both
   *  `interactionMode` and `sendTurn` (design spec §7), so it applies the
   *  mode switch before sending rather than this component reaching for
   *  `controls.setInteractionMode` itself. Optional, same pattern as
   *  `onRespondToUserInput`/`onRespondToApproval` above. */
  onPlanFollowUp?: (submission: PlanFollowUpSubmission) => void
  /** Ambient conditions (connection, transport error, agent-missing, session
   *  stopped) — `AgentChatPane` computes these via `composerBanners` and
   *  attaches icons/`onDismiss` closures; this component only renders them
   *  (spec `2026-08-15-composer-banner-stack-design.md` Design §7). Defaults
   *  to `[]` so every pre-existing render in `ChatComposer.test.tsx` (none of
   *  which know about banners) needs no change. */
  banners?: ComposerBannerStackItem[]
  /** Keys this composer's draft in `useDevDeckStore.composerDrafts` and
   *  gates the 300ms debounced mirror-write (design spec §2). Optional —
   *  same pattern `NO_MACHINE` uses: omitting it leaves drafts dormant
   *  rather than erroring, so `ChatComposer.test.tsx`'s many pre-existing
   *  renders that predate drafts keep passing unmodified. The stash
   *  badge/menu/⌘S chord are NOT gated on this — the stash is global, not
   *  per-thread (spec §5). */
  threadKey?: string
}

/** The `p-px` ring around the surface — a one-pixel padding frame so a later
 *  state (ultrathink) can paint a border-width gradient through it without a
 *  pseudo-element. Left unstyled here, on purpose: see the design spec's §1. */
const FRAME = 'group rounded-[22px] p-px'

/** The box the user actually sees. Direct replacement for the old `BOX`
 *  descendant-selector hack, now just real classes on a div we own:
 *  hairline border, raised surface fill, no shadow, and a 1px accent ring
 *  when the editor itself (not some unrelated descendant) holds focus.
 *  `relative` so the stash badge (plan T9, design spec §6) can anchor to
 *  this box's top-right shoulder. */
const SURFACE = [
  'relative flex flex-col gap-1.5 rounded-[20px] border border-devdeck-hairline bg-devdeck-raised',
  // Padding scales with the box, not the viewport: this composer is as likely
  // to be 260px wide in the SSH rail as 768px in a full pane, and the wide
  // inset that reads as generous at 768px eats a third of the line at 260px.
  'px-3 pt-3 pb-2 @sm/composer:gap-2 @sm/composer:px-4 @sm/composer:pt-3.5',
  'shadow-none transition-colors',
  // Ring only, never ring + accent border: both together paint 2px of full
  // accent around the box, which at rail width is the loudest thing on the
  // pane by a distance. The hairline border stays where it is underneath.
  'has-[[contenteditable]:focus]:ring-1 has-[[contenteditable]:focus]:ring-devdeck-border-accent',
].join(' ')

/** The action button: a filled circle, the single primary action on this
 *  surface and the one place the accent is allowed to fill a shape. Empty
 *  keeps the circle and drops its saturation rather than going grey — the
 *  affordance has to stay findable when the box is empty, which is exactly
 *  when the user is looking for it. */
const SEND = [
  'size-8 rounded-full p-0',
  'bg-devdeck-accent text-devdeck-accent-ink',
  'hover:bg-devdeck-accent-hover hover:text-devdeck-accent-ink',
  'disabled:bg-devdeck-accent/30 disabled:text-devdeck-fg-2 disabled:opacity-100',
].join(' ')

/** The same circle in its interrupt state: destructive fill, so "stop" is
 *  never mistaken for "send" at a glance. */
const STOP = 'size-8 rounded-full bg-devdeck-err p-0 text-devdeck-accent-ink hover:bg-devdeck-err hover:opacity-90'

/** The plan follow-up's action button — a labelled pill, not the plain
 *  circle above. "Implement" and "Refine" are two different actions the
 *  user has to be able to tell apart at a glance, which a shared icon-only
 *  circle cannot do; the ported original makes the same call
 *  (`ComposerPrimaryActions.tsx:151-176`, a filled rounded rectangle with
 *  visible text for both). */
const FOLLOW_UP_ACTION = [
  'h-8 shrink-0 rounded-full px-4 text-[13px] font-medium',
  'bg-devdeck-accent text-devdeck-accent-ink',
  'hover:bg-devdeck-accent-hover hover:text-devdeck-accent-ink',
].join(' ')

export function ChatComposer({
  status,
  onSend,
  onAbort,
  machine,
  worktreeId,
  mentionSource,
  controls,
  variant = 'docked',
  pendingUserInputs = [],
  onRespondToUserInput = () => {},
  pendingApprovals = [],
  onRespondToApproval = () => {},
  plan = null,
  onPlanFollowUp = () => {},
  banners = [],
  threadKey,
}: ChatComposerProps) {
  // Hydrated once, on mount, from the store's mirror — never re-read on a
  // later `composerDrafts` change, so the store stays a mirror of `text`,
  // not its source (design spec §2). `getState()`, not the `useDevDeckStore`
  // hook, is deliberate: subscribing here would re-run this initializer on
  // every store update, which is exactly the per-keystroke coupling this
  // hydrate-once contract forbids.
  const [text, setText] = useState<string>(() =>
    threadKey ? (useDevDeckStore.getState().composerDrafts[threadKey]?.text ?? '') : '',
  )
  const hero = variant === 'hero'
  const surfaceRef = useRef<HTMLDivElement>(null)
  // Imperative on purpose — see ComposerAttachments.tsx's doc comment: the
  // parent never watches an upload's progress, it only reads the finished
  // refs once, at submit.
  const attachmentsRef = useRef<ComposerAttachmentsHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // T15's C3 bridge target — `insertTerminalContext`'s `insert()` reaches
  // through here to call T14's `insertChip`.
  const editorRef = useRef<ComposerPromptEditorHandle>(null)
  // destination -> captured `{destination, text}`, populated by the bridge
  // above as each terminalContext chip is inserted — see
  // `appendTerminalContexts`'s doc comment for how this and the live
  // document reconcile at submit time.
  const terminalContextCapturesRef = useRef(new Map<string, TerminalContextCapture>())
  const stashCount = useDevDeckStore((s) => s.promptStash.length)
  const stashEntries = useDevDeckStore((s) => s.promptStash)
  const [stashMenuOpen, setStashMenuOpen] = useState(false)

  // ── Terminal-context bridge target (design spec C3, T15) ──
  //
  // Registers this composer's insertion target under its own `threadKey` for
  // `insertTerminalContext` (module-level, above) to reach — nothing here
  // watches for a capture; it's a pure callback target. `destination` is
  // derived by running the SAME `serializeComposerDoc`/`composerTerminalContextChip`
  // T1 uses for the live document against a one-node doc, rather than
  // reimplementing its escaping/encoding here — that keeps this the single
  // source of truth for what a chip serializes to, so it can never drift out
  // of sync with what `appendTerminalContexts` later greps out of `text`.
  useEffect(() => {
    if (!threadKey) return
    const target: TerminalContextChatTarget = {
      insert(value, label, text) {
        const chipMarkdown = serializeComposerDoc({ type: 'doc', content: [composerTerminalContextChip(value, label)] })
        const destinationMatch = /\(([^)]*)\)$/.exec(chipMarkdown)
        const destination = destinationMatch ? destinationMatch[1]! : `terminal:${value}`
        terminalContextCapturesRef.current.set(destination, { destination, text })
        editorRef.current?.insertChip('terminalContext', value, label)
      },
    }
    terminalContextChatTargets.set(threadKey, target)

    const queued = pendingTerminalContextInserts.get(threadKey)
    if (queued && queued.length > 0) {
      pendingTerminalContextInserts.delete(threadKey)
      for (const capture of queued) target.insert(capture.value, capture.label, capture.text)
    }

    return () => {
      if (terminalContextChatTargets.get(threadKey) === target) terminalContextChatTargets.delete(threadKey)
    }
  }, [threadKey])

  // ── Draft mirror ──
  //
  // `text` stays the live value (unchanged from G); this only writes a
  // trailing-debounced copy to the store so a reload or a hero↔docked
  // remount (problem 2) has somewhere to recover it from. Keyed off
  // `threadKey` being present at all — omitting it (every pre-existing
  // `ChatComposer.test.tsx` render) leaves this permanently inert.
  const latestTextRef = useRef(text)
  useEffect(() => {
    latestTextRef.current = text
  }, [text])

  useEffect(() => {
    if (!threadKey) return
    const timer = window.setTimeout(() => {
      useDevDeckStore.getState().setComposerDraft(threadKey, text)
    }, COMPOSER_DRAFT_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [threadKey, text])

  // Flushes the last value straight to the store, bypassing the debounce —
  // separate from the effect above (deliberately not keyed on `text`) so it
  // fires exactly once, on unmount (or a `threadKey` change), rather than on
  // every keystroke. Without this, typing then closing the tab within the
  // 300ms window would lose the draft even though the debounce "should"
  // have caught it eventually — it never gets the chance to.
  useEffect(() => {
    return () => {
      if (threadKey) useDevDeckStore.getState().setComposerDraft(threadKey, latestTextRef.current)
    }
  }, [threadKey])

  // ── ⌘S / Ctrl+S — stash or open the stash menu ──
  //
  // Capture-phase on `window`, gated on the composer's own editor DOM node
  // owning focus (design spec §6). Three window-level Cmd/Ctrl+S listeners
  // already exist for file editors (`FileEditor.tsx`, `SSHFileEditor.tsx`,
  // `UntitledFileEditor.tsx`), all bubble-phase and gated only on their own
  // tab being active, not on focus — so a split pane with a file editor on
  // one side and this composer focused on the other would save the file
  // instead of stashing the prompt unless this handler wins the race.
  // Capture reaches `window` before those bubble-phase listeners ever run,
  // and `stopPropagation()` (not just `preventDefault()`) is what actually
  // stops them from firing at all.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return
      if (!surfaceRef.current?.contains(document.activeElement)) return

      event.preventDefault()
      event.stopPropagation()

      const trimmed = text.trim()
      if (trimmed.length === 0) {
        setStashMenuOpen(true)
        return
      }

      const result = useDevDeckStore.getState().stashPrompt(trimmed)
      if (!result.ok) {
        toast.error('Could not stash the prompt — storage is full or unavailable.')
        return
      }
      setText('')
      if (threadKey) useDevDeckStore.getState().clearComposerDraft(threadKey)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [text, threadKey])

  // Restore = remove the entry from the stash and drop it into the box.
  // Swap, not overwrite: a non-empty composer stashes its own text first, so
  // ⌘S followed by Enter never destroys anything (design spec §6).
  function handleStashSelect(id: string) {
    const restored = useDevDeckStore.getState().takeStashEntry(id)
    if (!restored) return
    const trimmed = text.trim()
    if (trimmed.length > 0) useDevDeckStore.getState().stashPrompt(trimmed)
    setText(restored.text)
    setStashMenuOpen(false)
  }

  function handleStashDelete(id: string) {
    useDevDeckStore.getState().deleteStashEntry(id)
  }

  // The effective agent for the next turn — drives the `$` skill catalog
  // (`ComposerPromptEditor`, D5). The model picker can move a thread to a
  // different agent (`ModelPicker.tsx:50-55`), and the skill catalog must
  // follow the agent that will actually run, not the worktree's static
  // default (design spec §5).
  const agentId = controls.model?.agentId ?? controls.worktreeAgentId

  // The adapter owns the thread-status → ChatStatus mapping, so "is the agent
  // generating" has one definition.
  const chatStatus = promptChatStatus({ ...emptyThreadView(), status })
  const generating = chatStatus === 'streaming' || chatStatus === 'submitted'
  const draft = text.trim()

  // ── One button, not two ──
  //
  // The composer used to show Stop AND Send side by side whenever the agent
  // was busy. Two circular buttons 8px apart, one red one teal, both live, is
  // a coin flip at a glance — and it was there to solve a real problem, so it
  // cannot simply be deleted: the backend explicitly allows a follow-up
  // message to STEER an in-flight turn (see the design note on
  // `CmdThreadTurnStart` in the engine's `Decide`), and `waiting` is the state
  // where the agent is asking the user something, i.e. exactly when a click
  // must send rather than abort.
  //
  // The draft settles it. Having typed something, the only thing that button
  // can sensibly mean is "send it" — steering and answering both stay reachable
  // while the agent runs. With an empty box there is nothing to send, so the
  // button is the interrupt. That is also why the vendored `PromptInputSubmit`
  // can't decide this on its own: it flips on status alone and would abort a
  // typed answer.
  const interrupting = generating && draft.length === 0

  // ── Plan follow-up (design spec §7) ──
  //
  // The same three-way condition `ComposerPlanFollowUpBanner` (T10) checks
  // internally to decide whether to render at all — recomputed here because
  // the action button needs to know WHICH of Implement/Refine to become,
  // not just whether a banner is showing. `null` whenever the condition
  // doesn't hold, which both gates the button branch below and hands the
  // exact submission `resolvePlanFollowUpSubmission` (T8) already decided,
  // so this component never invents its own copy of that mapping.
  const followUpSubmission: PlanFollowUpSubmission | null =
    controls.interactionMode === 'plan' && status === 'idle' && plan !== null
      ? resolvePlanFollowUpSubmission({ draftText: text, planMarkdown: plan.text })
      : null

  function handlePlanFollowUpClick() {
    if (!followUpSubmission) return
    setText('')
    // Same clear-on-submit contract `submit()` already applies below.
    if (threadKey) useDevDeckStore.getState().clearComposerDraft(threadKey)
    onPlanFollowUp(followUpSubmission)
  }

  // ── Pending user-input draft ──
  //
  // A queue-of-one: `ComposerPendingUserInputPanel` only ever shows the head
  // of `pendingUserInputs`, so the draft/index this composer owns tracks that
  // one active prompt. A fresh prompt starts its own draft at its own first
  // question — carrying over the previous prompt's answers/index would show
  // the wrong progress against the new questions.
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({})
  const [questionIndex, setQuestionIndex] = useState(0)
  const activeRequestId = pendingUserInputs[0]?.requestId

  useEffect(() => {
    setAnswers({})
    setQuestionIndex(0)
  }, [activeRequestId])

  function onToggleOption(questionId: string, optionLabel: string) {
    const prompt = pendingUserInputs[0]
    if (!prompt) return
    const question = prompt.questions.find((q) => q.id === questionId)
    if (!question) return
    setAnswers((existing) => ({
      ...existing,
      [questionId]: togglePendingUserInputOptionSelection(question, existing[questionId], optionLabel),
    }))
  }

  function onAdvance() {
    const prompt = pendingUserInputs[0]
    if (!prompt) return
    const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex)
    if (!progress.isLastQuestion) {
      setQuestionIndex(progress.questionIndex + 1)
      return
    }
    const resolved = buildPendingUserInputAnswers(prompt.questions, answers)
    if (resolved) onRespondToUserInput(prompt.requestId, resolved)
  }

  function submit() {
    const trimmed = text.trim()
    const attachments = attachmentsRef.current?.attachments() ?? []
    // A message needs either words or a picture — but not both: an image
    // with no caption is still a real send (design spec's C2 section never
    // requires text alongside an attachment), so the empty-draft guard only
    // blocks when there is truly nothing to send.
    if (!trimmed && attachments.length === 0) return
    // Design spec C3, "The block, at send time" — every `terminalContext`
    // chip still present in `trimmed` gets its captured text appended as a
    // trailing `<terminal_context>` block; a chip the user removed before
    // submit is already gone from `trimmed`, so it never reaches here (the
    // join-key property, enforced by construction — see
    // `appendTerminalContexts`'s doc comment).
    onSend(appendTerminalContexts(trimmed, terminalContextCapturesRef.current), attachments)
    setText('')
    attachmentsRef.current?.clear()
    terminalContextCapturesRef.current.clear()
    // Synchronous, before any pending debounce tick can fire (design spec
    // §2) — a send is never followed by a stray write that resurrects the
    // draft it just cleared.
    if (threadKey) useDevDeckStore.getState().clearComposerDraft(threadKey)
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    submit()
  }

  // ── Image attachments (composer-context-attachments, C2) ──
  //
  // Three capture entry points converge on `ComposerAttachments.addFiles`
  // (design spec §"Capture"): paste and drop on the composer surface, and
  // the paperclip button's hidden file input below. `disabled` on the
  // paperclip mirrors the effective-agent computation the skill catalog
  // already uses above — pi cannot carry attachments (provider/pi/adapter.go's
  // explicit error, T5), so the button is disabled before the user discovers
  // that at send time (design spec's Risks section, "Pi divergence").
  const attachmentsDisabled = agentId === 'pi'

  function handleAttachmentFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    if (event.currentTarget.files) attachmentsRef.current?.addFiles(event.currentTarget.files)
    event.currentTarget.value = ''
  }

  function handleSurfacePaste(event: ReactClipboardEvent<HTMLDivElement>) {
    const files = event.clipboardData?.files
    if (files && files.length > 0) attachmentsRef.current?.addFiles(files)
  }

  function handleSurfaceDrop(event: ReactDragEvent<HTMLDivElement>) {
    const files = event.dataTransfer?.files
    if (!files || files.length === 0) return
    event.preventDefault()
    attachmentsRef.current?.addFiles(files)
  }

  function handleSurfaceDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
  }

  // The box's padding is part of the box: clicking the empty strip beside or
  // under the text put focus nowhere, so a click that visibly landed "in the
  // input" did nothing — the single most common way to miss a one-line-tall
  // editor inside a 20px-padded surface. Gated on the surface being the click
  // target ITSELF, so every descendant (the pills, the paperclip, the send
  // button, the approval panels, the attachment strip) keeps its own click
  // untouched; `mousedown` rather than `click` so focus lands before the
  // browser would otherwise move it.
  function handleSurfaceMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    const editable = surfaceRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')
    if (!editable) return
    event.preventDefault()
    editable.focus()
  }

  return (
    // A SECOND container, wrapping the first. `@container/composer` below
    // sits on the `<form>` and therefore cannot size the form's OWN padding —
    // a container query only ever matches descendants of its container. That
    // padding is exactly what needs to shrink in a 300px rail (20px a side of
    // outer gutter, on top of the surface's own inset, pushed the first
    // character ~32px in from the pane edge), so it queries this outer shell
    // instead. The inner `@sm/composer` breakpoint keeps measuring the same
    // box it always has.
    <div
      className={cn(
        '@container/composer-shell flex flex-none flex-col',
        hero ? 'w-full' : 'border-t border-devdeck-hairline bg-devdeck-pane',
      )}
    >
      {/* Ambient conditions render above the form, in the same measure —
          its own copy of `mx-auto w-full min-w-0 max-w-3xl` plus the
          variant's horizontal inset, NOT hoisted onto a shared wrapper with
          the form: the `@container/composer` query below is sized off the
          whole form on purpose (see this file's doc comment, and spec
          Design §7). Returns `null` when empty, so an empty stack costs no
          DOM and no space. */}
      <ComposerBannerStack
        items={banners}
        className={cn('w-full min-w-0', hero ? undefined : 'px-3 @sm/composer-shell:px-5')}
      />
      <form
        onSubmit={handleFormSubmit}
        className={cn(
          '@container/composer mx-auto w-full min-w-0 max-w-3xl',
          hero ? 'px-0' : cn('px-3 pb-2 @sm/composer-shell:px-5', banners.length > 0 ? 'pt-0' : 'pt-2.5 @sm/composer-shell:pt-3'),
        )}
      >
        <div className={FRAME}>
          <div
            ref={surfaceRef}
            className={SURFACE}
            onMouseDown={handleSurfaceMouseDown}
            onPaste={handleSurfacePaste}
            onDrop={handleSurfaceDrop}
            onDragOver={handleSurfaceDragOver}
          >
            {/* Feeds `ComposerAttachments.addFiles` from the paperclip button
                below — hidden, `accept="image/*"` so a non-image pick never
                round-trips through the upload-then-400 path (the server
                sniffs the real content type anyway; this is just so the
                native picker itself doesn't offer the wrong files). */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleAttachmentFilesSelected}
            />
            {/* Stash badge (T7) + menu (T8), opened by ⌘S on an empty
                composer or by clicking the badge directly. The badge is its
                own standalone, absolutely-positioned button (design spec
                §6: "opening it does not steal focus from the editor") —
                deliberately NOT nested inside `TabStripPopoverMenu`'s own
                trigger button, which would put a `<button>` inside a
                `<button>`. `TabStripPopoverMenu` still owns the popup shell
                (it registers `useNativeOverlayBlocker`, load-bearing for the
                Tauri browser tile per spec §6), so it gets an invisible,
                unclickable trigger positioned over the same spot purely as
                a floating-ui anchor; `open`/`onOpenChange` do the rest. */}
            <ComposerStashBadge count={stashCount} onClick={() => setStashMenuOpen(true)} />
            <TabStripPopoverMenu
              trigger={<span aria-hidden="true" />}
              triggerClassName="pointer-events-none invisible absolute -top-3 right-4 h-6 w-6"
              triggerTitle="Stashed prompts"
              triggerAriaLabel="composer-stash-anchor"
              align="end"
              open={stashMenuOpen}
              onOpenChange={setStashMenuOpen}
            >
              <ComposerStashMenu
                entries={stashEntries}
                onSelect={handleStashSelect}
                onDelete={handleStashDelete}
                onClose={() => setStashMenuOpen(false)}
              />
            </TabStripPopoverMenu>

            {/* Pending user-input (AskUserQuestion) and pending approval
                (can_use_tool) panels share this one slot, directly above the
                editor. Precedence (decided in plan T18 — the spec's data-flow
                diagram shows both as siblings without saying which wins):
                the user-input panel wins whenever both are simultaneously
                pending. A question is rarer and typically gates what the
                agent does next; an approval can wait one extra render. Both
                panels already show their own n/m counter, so this is not the
                combined multi-kind queue UI the spec explicitly defers. */}
            {/* `empty:hidden` — the slot is always rendered so its position in
                the stack is reserved, but an empty div is still a flex child
                and still collects the surface's `gap` on both sides. With two
                of these (this and the attachment strip) that was ~18px of
                blank space wedged between the caret and the control row on
                every composer that had neither a pending panel nor an
                attachment, which is nearly all of them. */}
            <div data-slot="composer-panels" className="empty:hidden">
              {pendingUserInputs.length > 0 ? (
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  answers={answers}
                  questionIndex={questionIndex}
                  onToggleOption={onToggleOption}
                  onAdvance={onAdvance}
                />
              ) : pendingApprovals.length > 0 ? (
                <ComposerPendingApprovalPanel
                  pendingApprovals={pendingApprovals}
                  onRespondToApproval={onRespondToApproval}
                  // The SAME pair the permission pill is driven by, on purpose:
                  // the card's mode buttons and the pill must never be able to
                  // disagree about what the thread's mode is.
                  runtimeMode={controls.runtimeMode}
                  onChangeRuntimeMode={controls.setRuntimeMode}
                />
              ) : null}
              {/* T12 — B's own panel joins A's stack rather than replacing
                  it (design spec: "whichever lands second owns making the
                  slot a stack"). `ComposerPlanFollowUpBanner` owns its own
                  three-way visibility check and renders nothing outside it,
                  so mounting it unconditionally here costs no DOM when
                  there is no plan on the table. */}
              <ComposerPlanFollowUpBanner plan={plan} interactionMode={controls.interactionMode} status={status} />
            </div>

            {/* A sibling of `composer-panels`, never nested inside it — A's
                slot stays reserved (design spec §"Where they render"). */}
            <ComposerAttachments ref={attachmentsRef} machine={machine ?? NO_MACHINE} threadId={threadKey ?? ''} />

            <ComposerPromptEditor
              ref={editorRef}
              value={text}
              onChange={setText}
              onSubmit={submit}
              // Short enough to fit one line in the narrowest box this
              // composer ships in (the ~260px SSH rail). The editor clips its
              // placeholder to one line now, so a longer string would not
              // break the layout — it would just read as "Ask for changes, or
              // desc…", which is worse than a sentence that fits.
              placeholder={hero ? 'Describe what to build…' : 'Ask anything…'}
              machine={machine ?? NO_MACHINE}
              worktreeId={worktreeId ?? ''}
              mentionSource={mentionSource}
              agentId={agentId}
              onInteractionModeChange={controls.setInteractionMode}
            />

            <footer className="flex items-center gap-1 @sm/composer:gap-2">
              <div className="min-w-0 flex-1 overflow-hidden">
                {/* ── Where the row actually fits ──
                    `@2xl` (42rem), not `@sm` (24rem), and the number is
                    measured rather than picked: the five pills lay out at
                    549px with the model pill already floored, and this row is
                    handed `container - 116px` (the surface inset, the
                    paperclip, the send button and the gaps between them). So
                    it needs ~665px of container and had been rendering from
                    384px, where its own `overflow-hidden` cut the trailing
                    pills mid-glyph — "Approval requ" and a half-drawn hammer
                    in the screenshots. Note the query measures the form's
                    CONTENT box, i.e. 40px less than its border box.
                    Below the stop the "More controls" popup carries the
                    identical row, legibly, one click away. */}
                <div
                  data-testid="composer-controls-inline"
                  className="hidden min-w-0 flex-nowrap items-center gap-0.5 overflow-hidden @2xl/composer:flex"
                >
                  <ComposerControls {...controls} variant="inline" />
                </div>
                <div className="@2xl/composer:hidden">
                  <TabStripPopoverMenu
                    trigger={<MoreHorizontal size={14} aria-hidden="true" />}
                    triggerClassName={cn(composerControlClassName, 'flex w-7 items-center justify-center px-0')}
                    triggerTitle="More controls"
                    triggerAriaLabel="More controls"
                    align="start"
                  >
                    <div data-testid="composer-controls-menu" className="flex flex-col gap-1">
                      <ComposerControls {...controls} variant="menu" />
                    </div>
                  </TabStripPopoverMenu>
                </div>
              </div>

              <PromptInputButton
                aria-label="Attach image"
                disabled={attachmentsDisabled}
                title={attachmentsDisabled ? "Image attachments aren't supported on pi" : 'Attach an image'}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={14} aria-hidden="true" />
              </PromptInputButton>

              {interrupting ? (
                <PromptInputButton aria-label="Stop" className={STOP} onClick={onAbort} title="Interrupt this turn">
                  <Square size={11} fill="currentColor" aria-hidden="true" />
                </PromptInputButton>
              ) : followUpSubmission ? (
                // The follow-up state's third button (design spec §7):
                // label/handler come straight from `resolvePlanFollowUpSubmission`
                // (T8), not the send/interrupt branch below. `type="button"`
                // is load-bearing — this button still sits inside the same
                // `<form>`, and the default `type="submit"` would also fire
                // `handleFormSubmit` (and therefore `onSend`) on the same
                // click.
                <button
                  type="button"
                  className={FOLLOW_UP_ACTION}
                  onClick={handlePlanFollowUpClick}
                  title={followUpSubmission.action === 'implement' ? 'Implement this plan' : 'Refine the plan'}
                >
                  {followUpSubmission.action === 'implement' ? 'Implement' : 'Refine'}
                </button>
              ) : (
                /* `undefined` children on error is deliberate: `PromptInputSubmit`
                   falls back to its own icon set, so a rejected turn shows the
                   vendored ✕ rather than an arrow that looks ready to send. */
                <PromptInputSubmit
                  className={SEND}
                  status={chatStatus === 'error' ? 'error' : 'ready'}
                  disabled={draft.length === 0}
                  title={generating ? 'Send — steers the turn in flight' : 'Send'}
                >
                  {chatStatus === 'error' ? undefined : <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />}
                </PromptInputSubmit>
              )}
            </footer>
          </div>
        </div>
      </form>
    </div>
  )
}
