/**
 * The composer's control row, wired for real (plan Task 7). `ComposerControl`
 * (Task 6) supplied the ghost-pill primitives; `ChatComposer.tsx` (Task 6)
 * still renders its own `disabled` placeholder row because Task 6 was layout
 * only — see that file's doc comment. This component is the functioning
 * replacement, built and unit-tested standalone here.
 *
 * `ChatComposer.tsx` is not in Task 7's file list, so this component is not
 * yet mounted in the render tree — see this task's `deviationsFromPlan`.
 * Swapping it in is a drop-in replacement: `PillWrap` below reproduces
 * `ChatComposer.tsx`'s `ControlPills` wrapper (`variant` prop, divider
 * placement) exactly.
 *
 * Runtime mode dispatches a real command immediately (`setRuntimeMode` on
 * `useAgentChatSocket`) — it changes how the agent behaves for the whole
 * thread. Model, effort and context window do not dispatch anything here —
 * per the design spec's control table they "ride" the next
 * `thread.turn.start` payload, which is `AgentChatPane.tsx`'s `turnModel`.
 *
 * Interaction mode (Build/Plan) is still part of `ComposerControlsProps` —
 * `ChatComposer` reads it for the plan follow-up banner and the `/plan` /
 * `/build` slash commands dispatch through `setInteractionMode` — but it no
 * longer has a pill of its own in this row: the toggle was judged not worth
 * its width, and the slash commands are the way to switch.
 *
 * Error handling (design spec): "Mode command rejected by the decider ->
 * Pill reverts to the thread's actual mode; error surfaces in the
 * transcript, never silently." The wire protocol's `error` frame carries no
 * `commandId` to correlate against (see `agent_ws.go`'s `writeError`), so
 * this reverts *any* pill with an optimistic change in flight when a fresh
 * error arrives — coarser than per-command correlation, but it never lets a
 * pill keep showing a mode the agent isn't actually in, which is the
 * property the spec asks for. For that to hold, `value` MUST be the thread's
 * actual mode (`AgentThreadView.runtimeMode`, replayed from the event log),
 * not a copy the parent updated optimistically — see `usePillState`. The
 * transcript itself renders `view.error` separately (`AgentChatPane.tsx`);
 * this component never swallows it.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Check, Gauge, Lock, LockOpen, Pencil, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from '@/features/agent-chat/ComposerControl'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_EFFORT } from '@/features/agent-chat/composerTurnOptions'
import { ModelPicker } from '@/features/agent-chat/ModelPicker'
import type { ModelChoice } from '@/features/agent-chat/ModelPicker'
import type { InteractionMode, RuntimeMode } from '@/features/agent-chat/useAgentChatSocket'
import { tourAnchor, type TourAnchor } from '@/features/tour/tourAnchors'
import type { Machine } from '@/store/types'

/** Keeps a pill's tour anchor on the row that is really on screen. This row
 *  renders twice — once inline, once inside the "More controls" popup below
 *  `@2xl/composer` — and only one of the two is ever visible. Anchoring both
 *  would leave `document.querySelector` free to pick the hidden copy and
 *  spotlight nothing.
 *
 *  Takes the built anchor rather than its name so each call site still reads
 *  `tourAnchor('chat-model')` literally: `tourAnchors.guard.test.ts` greps the
 *  source for exactly that call, and an anchor hidden behind a name argument
 *  would look unattached to it. */
function inlineOnly(variant: 'inline' | 'menu', anchor: { 'data-tour': TourAnchor }) {
  return variant === 'inline' ? anchor : undefined
}

// The defaults live in `composerTurnOptions.ts` (a pure module the store can
// import); re-exported here for the callers that always read them from this
// file.
export { DEFAULT_CONTEXT_WINDOW, DEFAULT_EFFORT }

export interface Option<T extends string> {
  value: T
  label: string
}

/** One row of the restyled permission picker: an icon, DevDeck's own label
 *  (unchanged — these are the labels every other surface in the app already
 *  uses for `RuntimeMode`), and a description of what the mode actually does.
 *  Mirrors `provider.RuntimeMode`; the descriptions describe the real
 *  behaviour `buildArgs` (claude/adapter.go) already implements for each
 *  `--permission-mode` value, not aspirational copy. */
export interface PermissionOption {
  value: RuntimeMode
  label: string
  description: string
  icon: LucideIcon
}

export const PERMISSION_OPTIONS: PermissionOption[] = [
  { value: 'approval-required', label: 'Approval required', description: 'Ask before commands and file changes.', icon: Lock },
  { value: 'auto-accept-edits', label: 'Auto-accept edits', description: 'Auto-approve edits, ask before other actions.', icon: Pencil },
  { value: 'auto', label: 'Auto', description: 'Supported providers approve routine actions; others still ask.', icon: Sparkles },
  { value: 'full-access', label: 'Full access', description: 'Allow commands and edits without prompts.', icon: LockOpen },
]

/** Kept for the one caller still importing the flat option list directly
 *  (nothing left as of this file's last edit, but the shape is trivial to
 *  keep in step and a dropped export is a silent break for anything outside
 *  this package that isn't in the grep this repo can see). */
export const RUNTIME_MODE_OPTIONS: Option<RuntimeMode>[] = PERMISSION_OPTIONS.map(({ value, label }) => ({ value, label }))

/** One row of the Reasoning section. `--effort` (verified real flag,
 *  `claude --help`: "Effort level for the current session (low, medium,
 *  high, xhigh, max)") degrades gracefully on the CLI side — an unrecognised
 *  value warns to stderr and falls back to the default, so unlike the
 *  context-window flag below there is nothing to validate client-side. */
export interface ReasoningOption {
  value: string
  label: string
  isDefault?: boolean
}

export const REASONING_OPTIONS: ReasoningOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High', isDefault: DEFAULT_EFFORT === 'high' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
  // Not one of the CLI's five --effort values — Claude Code's maximum
  // extended-thinking mode has no flag of its own for --print sessions, so
  // this rides on 'max' instead of being silently dropped. See turnModel
  // in AgentChatPane.tsx.
  { value: 'ultrathink', label: 'Ultrathink' },
]

/** 200k/1M presets for `--autocompact` (verified real flag, `claude --help`:
 *  "Auto-compact window size (auto, or 100k–1M tokens)") — the token count at
 *  which Claude Code proactively compacts the conversation, not a hard
 *  per-model context ceiling. `Custom` (below) opens an inline field clamped
 *  to that same range: unlike --effort, an out-of-range --autocompact value
 *  is not a graceful fallback — the CLI refuses to start the session at all
 *  ("It must be 'auto', or between 100k and 1M"), so nothing this composer
 *  sends may ever land outside it. */
export interface ContextWindowOption {
  value: string
  label: string
  isDefault?: boolean
}

export const CONTEXT_WINDOW_PRESETS: ContextWindowOption[] = [
  { value: '200k', label: '200k', isDefault: DEFAULT_CONTEXT_WINDOW === '200k' },
  { value: '1M', label: '1M' },
]

export const MIN_CONTEXT_WINDOW_K = 100
export const MAX_CONTEXT_WINDOW_K = 1000

/** Clamps a custom window to the exact range `--autocompact` accepts — see
 *  `CONTEXT_WINDOW_PRESETS`'s doc comment on why this has to hold, not just
 *  approximate. Always returns the CLI's own `<n>k` shorthand. */
export function clampContextWindowK(rawK: number): string {
  if (!Number.isFinite(rawK)) return DEFAULT_CONTEXT_WINDOW
  const k = Math.round(Math.min(MAX_CONTEXT_WINDOW_K, Math.max(MIN_CONTEXT_WINDOW_K, rawK)))
  return `${k}k`
}

/** The token count a context-window SELECTION names — "200k" -> 200_000,
 *  "1M" -> 1_000_000. Used only to compute the usage indicator's percentage;
 *  never sent anywhere (the string itself already rides `--autocompact`
 *  verbatim, see buildArgs in claude/adapter.go). */
export function contextWindowTokens(value: string): number {
  if (/^1m$/i.test(value)) return 1_000_000
  const match = /^(\d+)k$/i.exec(value)
  if (match) return Number(match[1]) * 1000
  return contextWindowTokens(DEFAULT_CONTEXT_WINDOW)
}

/** `47000` -> `"47k"`, `1200000` -> `"1.2M"` — the composer's own compact
 *  vocabulary for a token count, matching what `--autocompact`'s presets
 *  already look like on screen. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return `${Math.round(tokens)}`
}

export interface ComposerControlsProps {
  /** The picked agent + model, or null to run the worktree's own default.
   *  Replaces the old `model: string` over a hardcoded four-id list, which
   *  never reached the backend at all. */
  model: ModelChoice | null
  onModelChange: (choice: ModelChoice) => void
  /** Needed by the picker to read the machine's real agent/model catalog. */
  machine: Machine
  /** The agent this worktree runs — the picker's default rail. */
  worktreeAgentId: string
  /** One of `REASONING_OPTIONS`' values — a bare `--effort` level (or
   *  `'ultrathink'`), no longer the old `level:thinking` compound string. */
  effort: string
  onEffortChange: (effort: string) => void
  /** A `CONTEXT_WINDOW_PRESETS` value or a custom `<n>k` from
   *  `clampContextWindowK` — rides straight onto `--autocompact`. */
  contextWindow: string
  onContextWindowChange: (contextWindow: string) => void
  /** `AgentThreadView.contextTokens` — real, measured occupancy as of the
   *  last completed turn. `0` before any turn has completed. */
  contextTokens: number
  /** The thread's actual interaction mode (`AgentThreadView.interactionMode`).
   *  Not rendered by this row any more — carried for `ChatComposer`'s plan
   *  follow-up and the `/plan` / `/build` slash commands. */
  interactionMode: InteractionMode
  setInteractionMode: (mode: InteractionMode) => void
  /** The thread's ACTUAL permission mode — `AgentThreadView.runtimeMode`,
   *  replayed from the event log — never a copy the parent set optimistically.
   *  The pill shows its own optimistic pick on top and reverts to this on a
   *  rejection; if this already held the pick there would be nothing true to
   *  revert to. */
  runtimeMode: RuntimeMode
  setRuntimeMode: (mode: RuntimeMode) => void
  /** The socket's current transport/decider error (`useAgentChatSocket`'s
   *  `view.error`) — used only to detect a rejection in flight, see the
   *  file's doc comment. `null` when there is none. */
  error: string | null
  /** Matches `ChatComposer.tsx`'s `ControlPills`: `'inline'` for the single
   *  row shown above the `@sm/composer` breakpoint, `'menu'` for the second
   *  copy rendered inside the overflow popup below it. */
  variant?: 'inline' | 'menu'
}

/** Shared popup chrome — every control's dropdown/popover in this file uses
 *  the same glass surface and open/close transition. */
const POPUP_SURFACE = [
  'origin-[var(--transform-origin)] rounded-control border border-devdeck-border-menu bg-devdeck-glass-solid',
  'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
  'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
  'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
].join(' ')

/** A small right-aligned tag — "Default" next to the option that is one,
 *  independent of which option is CURRENTLY selected (see REASONING_OPTIONS'
 *  doc comment: the two are different signals and can point at different
 *  rows). */
function DefaultBadge() {
  return (
    <span className="flex-none rounded-sm bg-devdeck-hover-wash-menu px-1.5 py-0.5 text-[10px] font-medium text-devdeck-fg-2">
      Default
    </span>
  )
}

/** The revert-on-rejection state machine behind `PermissionPicker`: an
 *  optimistic `pending` value that shows immediately, and reverts to `value`
 *  — "the thread's actual mode" — the moment a *fresh* error arrives with a
 *  change still in flight.
 *
 *  `pending` also clears the moment `value` itself moves. That is what makes
 *  the optimistic pick *settle* rather than stick: the engine echoes the
 *  accepted command back as a `thread.runtime-mode-set` event, `value`
 *  becomes the picked mode, and from then on the pill tracks the thread —
 *  so a later change from anywhere else (another pane, the approval card's
 *  own mode buttons, Telegram) shows through instead of being hidden behind
 *  a pick that was confirmed long ago. Exported for its tests. */
export function usePillState<T>(value: T, dispatch: (value: T) => void, error: string | null) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<T | null>(null)

  useEffect(() => {
    if (error !== null && pending !== null) setPending(null)
    // Only a *new* error should trigger a revert — re-running this whenever
    // `pending` changes would revert the very optimistic value this effect
    // is meant to protect, on the same render that set it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error])

  useEffect(() => {
    // The thread's actual mode moved — confirmed our pick, or was changed
    // elsewhere. Either way it is the truth now.
    setPending(null)
  }, [value])

  const displayed = pending ?? value

  function choose(next: T) {
    setPending(next)
    dispatch(next)
    setOpen(false)
  }

  return { open, setOpen, displayed, choose }
}

/** Reproduces `ChatComposer.tsx`'s `ControlPills` wrapper exactly — same
 *  divider placement and `variant` behaviour — so this component drops into
 *  that row without a layout change once it's wired in. */
function PillWrap({
  variant,
  first,
  shrink,
  anchor,
  children,
}: {
  variant: 'inline' | 'menu'
  first?: boolean
  /** The guided tour's anchor for this pill. Passed only by the `inline`
   *  variant — the `menu` copy renders the identical row inside a popover, so
   *  attaching it to both would put two elements with the same `data-tour` in
   *  the document and let the tour spotlight whichever came first. */
  anchor?: { 'data-tour': TourAnchor }
  /** Lets this pill absorb the row's overflow instead of pushing its
   *  neighbours out. Exactly one pill should set it — the model pill, whose
   *  label is the only one whose length varies with the data.
   *
   *  Every pill used to be `flex-none`, so nothing could shrink: the row is
   *  `flex-nowrap overflow-hidden`, which means a long model id did not
   *  truncate, it clipped whatever came after it. A real screenshot showed
   *  `High · 200(` cut mid-character and the two mode pills gone entirely. */
  shrink?: boolean
  children: ReactNode
}) {
  return (
    <span
      {...anchor}
      className={cn(
        'flex min-w-0 items-center',
        // `overflow-hidden` is the backstop, and it is load-bearing: `Button`'s
        // base class list ends in `shrink-0`, so a pill that does not opt back
        // out of that (see `ModelPicker`'s trigger) keeps its full content
        // width while THIS wrapper shrinks around it — and then paints outside
        // it, over the next pill, because neither one clipped. A real
        // screenshot showed `deepseek-v4-flash` and `High · 200k` printed on
        // top of each other. Clipping here makes that impossible for any pill,
        // including ones added later.
        // The floor is `min-w-28`, not something token-sized: this is the only
        // pill that shrinks, so it absorbs the WHOLE row's overflow, and at a
        // 64px floor `deepseek-v4-flash` collapsed to `d…` — a pill naming the
        // model that no longer names it. 112px keeps a recognisable prefix at
        // every width the inline row is used at, and lets the row's own
        // `overflow-hidden` clip from the trailing edge past that point, which
        // is what the `More controls` menu below `@sm/composer` exists to
        // recover.
        variant === 'menu' ? 'w-full' : shrink ? 'min-w-28 shrink overflow-hidden' : 'flex-none',
      )}
    >
      {variant === 'inline' && !first ? <span aria-hidden="true" className="mx-1 h-3.5 w-px flex-none bg-devdeck-hairline" /> : null}
      {children}
    </span>
  )
}

/** The permission picker: icon + bold title + description per row.
 *  `RuntimeMode`'s four values and DevDeck's own labels for them are the ones
 *  every other surface uses. Selecting a row shows it immediately (optimistic
 *  — the engine hasn't confirmed anything yet) and calls `dispatch`; if
 *  `error` is non-null and a change is still pending when it arrives, the
 *  pill reverts to `value` — see the file's doc comment on why this can't be
 *  correlated more precisely than "any pending change, any fresh error". */
function PermissionPicker({
  value,
  dispatch,
  error,
  variant,
}: {
  value: RuntimeMode
  dispatch: (mode: RuntimeMode) => void
  error: string | null
  variant: 'inline' | 'menu'
}) {
  const { open, setOpen, displayed, choose } = usePillState(value, dispatch, error)
  const popupRef = useRef<HTMLDivElement>(null)
  useNativeOverlayBlocker(open, popupRef)

  const active = PERMISSION_OPTIONS.find((option) => option.value === displayed) ?? PERMISSION_OPTIONS[0]

  return (
    <PillWrap variant={variant} anchor={inlineOnly(variant, tourAnchor('chat-permission'))}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger render={<ComposerControl className={variant === 'menu' ? 'w-full justify-start' : undefined} />}>
          <ComposerControlIcon icon={active.icon} />
          {active.label}
          <ComposerControlChevron />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} style={{ zIndex: 60 }} className="outline-none">
            <Popover.Popup ref={popupRef} className={cn('flex w-72 flex-col gap-0.5 p-1.5', POPUP_SURFACE)}>
              {PERMISSION_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => choose(option.value)}
                  className={cn(
                    'flex w-full cursor-pointer select-none items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none',
                    'hover:bg-devdeck-hover-wash-menu',
                    option.value === displayed && 'bg-devdeck-hover-wash',
                  )}
                >
                  <option.icon aria-hidden="true" className="mt-0.5 size-4 flex-none text-devdeck-fg-2" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13px] font-medium text-devdeck-fg">{option.label}</span>
                    <span className="text-[11.5px] leading-snug text-devdeck-fg-2">{option.description}</span>
                  </span>
                </button>
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </PillWrap>
  )
}

/** The combined Reasoning + Context Window picker. Trigger reads
 *  `${effort label} · ${context window label}` ("High · 200k"); the popup
 *  stacks the two sections with a divider, matching the reference layout.
 *  Neither value ever reverts on error (same as the old flat effort pill —
 *  see `PillProps.error`'s doc comment): both only ever ride the NEXT turn,
 *  so there is nothing on the wire yet for the engine to reject. */
function EffortContextPicker({
  effort,
  onEffortChange,
  contextWindow,
  onContextWindowChange,
  variant,
}: {
  effort: string
  onEffortChange: (effort: string) => void
  contextWindow: string
  onContextWindowChange: (contextWindow: string) => void
  variant: 'inline' | 'menu'
}) {
  const [open, setOpen] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)
  useNativeOverlayBlocker(open, popupRef)

  const isCustomWindow = !CONTEXT_WINDOW_PRESETS.some((preset) => preset.value === contextWindow)
  // What the custom field shows while it does NOT hold focus: the active
  // custom value once one is set, otherwise a sensible starting point rather
  // than a blank box the moment "Custom" first becomes relevant.
  const [customDraft, setCustomDraft] = useState(() => (isCustomWindow ? contextWindow.replace(/k$/i, '') : '500'))

  const effortLabel = REASONING_OPTIONS.find((option) => option.value === effort)?.label ?? effort
  const windowLabel = isCustomWindow ? contextWindow : contextWindow

  function commitCustom(raw: string) {
    const n = Number(raw)
    if (!raw || Number.isNaN(n)) return
    const clamped = clampContextWindowK(n)
    setCustomDraft(clamped.replace(/k$/i, ''))
    onContextWindowChange(clamped)
  }

  return (
    <PillWrap variant={variant} anchor={inlineOnly(variant, tourAnchor('chat-effort'))}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger render={<ComposerControl className={variant === 'menu' ? 'w-full justify-start' : undefined} />}>
          <ComposerControlIcon icon={Gauge} />
          {effortLabel} · {windowLabel}
          <ComposerControlChevron />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} style={{ zIndex: 60 }} className="outline-none">
            <Popover.Popup ref={popupRef} className={cn('w-60 p-1.5', POPUP_SURFACE)}>
              <div className="px-2.5 pt-1.5 pb-1 text-[11px] tracking-wide text-devdeck-fg-2 uppercase">Reasoning</div>
              {REASONING_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onEffortChange(option.value)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex h-8 w-full cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-left text-[13px] outline-none',
                    'text-devdeck-fg-2 hover:bg-devdeck-hover-wash-menu hover:text-devdeck-fg',
                    option.value === effort && 'bg-devdeck-hover-wash text-devdeck-fg',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.isDefault ? <DefaultBadge /> : null}
                  <Check aria-hidden="true" className={cn('size-3.5 flex-none', option.value === effort ? 'opacity-100' : 'opacity-0')} />
                </button>
              ))}

              <div aria-hidden="true" className="my-1.5 h-px bg-devdeck-hairline" />

              <div className="px-2.5 pt-1 pb-1 text-[11px] tracking-wide text-devdeck-fg-2 uppercase">Context Window</div>
              {CONTEXT_WINDOW_PRESETS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onContextWindowChange(option.value)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex h-8 w-full cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-left text-[13px] outline-none',
                    'text-devdeck-fg-2 hover:bg-devdeck-hover-wash-menu hover:text-devdeck-fg',
                    option.value === contextWindow && 'bg-devdeck-hover-wash text-devdeck-fg',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.isDefault ? <DefaultBadge /> : null}
                  <Check
                    aria-hidden="true"
                    className={cn('size-3.5 flex-none', option.value === contextWindow ? 'opacity-100' : 'opacity-0')}
                  />
                </button>
              ))}
              {/* Custom: clicking the row focuses the field rather than
                  immediately committing anything — there is no valid value to
                  commit until a number is typed, and 100-1000 is too wide a
                  range to guess a default the user actually wants. */}
              <label
                className={cn(
                  'flex h-8 w-full cursor-text select-none items-center gap-2 rounded-md px-2.5 text-left text-[13px]',
                  'text-devdeck-fg-2 hover:bg-devdeck-hover-wash-menu hover:text-devdeck-fg',
                  isCustomWindow && 'bg-devdeck-hover-wash text-devdeck-fg',
                )}
              >
                <span className="flex-none">Custom</span>
                <span className="ml-auto flex items-center gap-1">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={MIN_CONTEXT_WINDOW_K}
                    max={MAX_CONTEXT_WINDOW_K}
                    value={customDraft}
                    aria-label="Custom context window, in thousands of tokens"
                    onChange={(event) => setCustomDraft(event.target.value)}
                    onBlur={(event) => commitCustom(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      commitCustom((event.target as HTMLInputElement).value)
                      setOpen(false)
                    }}
                    className="w-14 rounded-sm bg-devdeck-hairline px-1.5 py-0.5 text-right text-[12.5px] text-devdeck-fg outline-none focus-visible:ring-1 focus-visible:ring-devdeck-border-accent"
                  />
                  <span className="text-devdeck-fg-2">k</span>
                </span>
                <Check aria-hidden="true" className={cn('size-3.5 flex-none', isCustomWindow ? 'opacity-100' : 'opacity-0')} />
              </label>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </PillWrap>
  )
}

/** A minimal SVG progress ring — the composer bar's compact "how full is the
 *  window" glance, matching the reference's trailing status icon. Drawn
 *  rather than a Lucide icon: the fill has to track a continuous percentage,
 *  which no icon set ships a component for. */
function UsageRing({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent))
  const radius = 6
  const circumference = 2 * Math.PI * radius
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true" className="flex-none -rotate-90">
      <circle cx="7.5" cy="7.5" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.75" />
      <circle
        cx="7.5"
        cy="7.5"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped / 100)}
      />
    </svg>
  )
}

/** The composer's context-window indicator: a progress ring that opens a
 *  breakdown on click (image reference: "Context Window · 4.9% · 47k/967k",
 *  a linear progress bar, "Total processed", and the auto-compact note).
 *  `max` is derived from whatever `contextWindow` is currently selected —
 *  the wire carries no server-reported maximum (see
 *  `AgentThreadView.contextTokens`'s doc comment), so the one source of
 *  truth for the denominator is the same picker the ring sits beside. */
function ContextWindowIndicator({
  contextTokens,
  contextWindow,
  variant,
}: {
  contextTokens: number
  contextWindow: string
  variant: 'inline' | 'menu'
}) {
  const [open, setOpen] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)
  useNativeOverlayBlocker(open, popupRef)

  const max = contextWindowTokens(contextWindow)
  const percent = max > 0 ? (contextTokens / max) * 100 : 0
  const percentLabel = percent < 10 ? percent.toFixed(1) : Math.round(percent).toString()
  const summary = `Context window: ${percentLabel}% used, ${formatTokenCount(contextTokens)} of ${formatTokenCount(max)} tokens`

  return (
    <PillWrap variant={variant} anchor={inlineOnly(variant, tourAnchor('chat-usage'))}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={<ComposerControl aria-label={summary} title={summary} className={cn('px-1.5', variant === 'menu' && 'w-full justify-start')} />}
        >
          <UsageRing percent={percent} />
          {variant === 'menu' ? <span className="min-w-0 flex-1 truncate text-left">Context window</span> : null}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="end" sideOffset={8} style={{ zIndex: 60 }} className="outline-none">
            <Popover.Popup ref={popupRef} className={cn('w-72 p-3.5', POPUP_SURFACE)}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium text-devdeck-fg">Context Window</span>
                <span className="flex-none text-[12px] text-devdeck-fg-2">
                  {percentLabel}% · {formatTokenCount(contextTokens)}/{formatTokenCount(max)}
                </span>
              </div>
              <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-devdeck-hairline">
                <div
                  className="h-full rounded-full bg-devdeck-accent transition-[width] duration-300"
                  style={{ width: `${Math.min(100, percent)}%` }}
                />
              </div>
              <div className="mt-3 flex items-center justify-between text-[12px]">
                <span className="text-devdeck-fg-2">Total processed</span>
                <span className="text-devdeck-fg">{formatTokenCount(contextTokens)}</span>
              </div>
              <p className="mt-2.5 text-[11.5px] leading-snug text-devdeck-fg-2">
                Claude automatically compacts its context when needed.
              </p>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </PillWrap>
  )
}

/** Model, Reasoning+Context Window, Permission — in that order — with the
 *  context-window usage ring trailing the row. `interactionMode` and
 *  `setInteractionMode` are accepted (see `ComposerControlsProps`) but not
 *  rendered: the Build/Plan pill was removed from this row. */
export function ComposerControls({
  model,
  onModelChange,
  machine,
  worktreeAgentId,
  effort,
  onEffortChange,
  contextWindow,
  onContextWindowChange,
  contextTokens,
  runtimeMode,
  setRuntimeMode,
  error,
  variant = 'inline',
}: ComposerControlsProps) {
  return (
    <>
      <PillWrap variant={variant} first shrink anchor={inlineOnly(variant, tourAnchor('chat-model'))}>
        <ModelPicker
          machine={machine}
          worktreeAgentId={worktreeAgentId}
          value={model}
          onChange={onModelChange}
          variant={variant}
        />
      </PillWrap>
      <EffortContextPicker
        effort={effort}
        onEffortChange={onEffortChange}
        contextWindow={contextWindow}
        onContextWindowChange={onContextWindowChange}
        variant={variant}
      />
      <PermissionPicker value={runtimeMode} dispatch={setRuntimeMode} error={error} variant={variant} />
      <ContextWindowIndicator contextTokens={contextTokens} contextWindow={contextWindow} variant={variant} />
    </>
  )
}
