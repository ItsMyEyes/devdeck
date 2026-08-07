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
 * Runtime mode and interaction mode dispatch real commands immediately
 * (`setRuntimeMode` / `setInteractionMode` on `useAgentChatSocket`). Model
 * and effort do not dispatch anything here — per the design spec's control
 * table they "ride" the next `thread.turn.start` payload, which is
 * `ChatComposer.tsx`'s responsibility once it is wired to this component.
 *
 * Error handling (design spec): "Mode command rejected by the decider ->
 * Pill reverts to the thread's actual mode; error surfaces in the
 * transcript, never silently." The wire protocol's `error` frame carries no
 * `commandId` to correlate against (see `agent_ws.go`'s `writeError`), so
 * this reverts *any* pill with an optimistic change in flight when a fresh
 * error arrives — coarser than per-command correlation, but it never lets a
 * pill keep showing a mode the agent isn't actually in, which is the
 * property the spec asks for. The transcript itself renders `view.error`
 * separately (`AgentChatPane.tsx`); this component never swallows it.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Gauge, Hammer, Lock, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from '@/features/agent-chat/ComposerControl'
import type { InteractionMode, RuntimeMode } from '@/features/agent-chat/useAgentChatSocket'

export interface Option<T extends string> {
  value: T
  label: string
}

/** Mirrors `registry.StaticRegistry`'s `claude` agent
 *  (`backend/internal/registry/static.go`) — the models actually offered for
 *  the default agent. Not fetched from `useAgentModels()` here: this
 *  component isn't wired to a worktree/agent yet (see the file's doc
 *  comment), so the catalog is the same static list the backend ships. */
export const MODEL_OPTIONS: Option<string>[] = [
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
]

/** `effort · thinking`, one control per the design spec's control table.
 *  `provider.ModelSelection.Options` is a free-form `map[string]any`
 *  ("effort, thinking, fastMode, ..."), so there is no backend enum to
 *  mirror here — this is the client's own compact vocabulary for it. */
export const EFFORT_OPTIONS: Option<string>[] = [
  { value: 'high:normal', label: 'High · Normal' },
  { value: 'medium:normal', label: 'Medium · Normal' },
  { value: 'low:normal', label: 'Low · Normal' },
  { value: 'high:extended', label: 'High · Extended' },
]

/** Mirrors `provider.InteractionMode` (`InteractionDefault` reads as "Build"
 *  in the product, matching t3code's own Build/Plan toggle). */
export const INTERACTION_MODE_OPTIONS: Option<InteractionMode>[] = [
  { value: 'default', label: 'Build' },
  { value: 'plan', label: 'Plan' },
]

/** Mirrors `provider.RuntimeMode`. */
export const RUNTIME_MODE_OPTIONS: Option<RuntimeMode>[] = [
  { value: 'approval-required', label: 'Approval required' },
  { value: 'auto-accept-edits', label: 'Auto-accept edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'full-access', label: 'Full access' },
]

export interface ComposerControlsProps {
  model: string
  onModelChange: (model: string) => void
  effort: string
  onEffortChange: (effort: string) => void
  interactionMode: InteractionMode
  setInteractionMode: (mode: InteractionMode) => void
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

function optionLabel<T extends string>(options: Option<T>[], value: T): string {
  return options.find((o) => o.value === value)?.label ?? value
}

/** Reproduces `ChatComposer.tsx`'s `ControlPills` wrapper exactly — same
 *  divider placement and `variant` behaviour — so this component drops into
 *  that row without a layout change once it's wired in. */
function PillWrap({ variant, first, children }: { variant: 'inline' | 'menu'; first?: boolean; children: ReactNode }) {
  return (
    <span className={cn('flex min-w-0 items-center', variant === 'inline' ? 'flex-none' : 'w-full')}>
      {variant === 'inline' && !first ? <span aria-hidden="true" className="mx-0.5 h-4 w-px flex-none bg-devdeck-line" /> : null}
      {children}
    </span>
  )
}

interface PillProps<T extends string> {
  icon: LucideIcon
  options: Option<T>[]
  /** The value this pill would show with no optimistic change in flight —
   *  "the thread's actual mode" it reverts to on rejection. */
  value: T
  dispatch: (value: T) => void
  /** `null` for pills that never hit the wire (model, effort) — those never
   *  revert, since there is nothing on the other end to reject them. */
  error: string | null
  variant: 'inline' | 'menu'
  /** The leading pill in the row skips the divider `PillWrap` would
   *  otherwise draw in front of it. */
  first?: boolean
}

/** One ghost pill: a trigger showing the current value, a popover listing
 *  every option. Selecting one shows it immediately (optimistic — the
 *  engine hasn't confirmed anything yet) and calls `dispatch`. If `error`
 *  is non-null and a change is still pending when it arrives, the pill
 *  reverts to `value` — see the file's doc comment on why this can't be
 *  correlated more precisely than "any pending change, any fresh error". */
function Pill<T extends string>({ icon, options, value, dispatch, error, variant, first }: PillProps<T>) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<T | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  useNativeOverlayBlocker(open, popupRef)

  useEffect(() => {
    if (error !== null && pending !== null) setPending(null)
    // Only a *new* error should trigger a revert — re-running this whenever
    // `pending` changes would revert the very optimistic value this effect
    // is meant to protect, on the same render that set it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error])

  const displayed = pending ?? value

  function choose(next: T) {
    setPending(next)
    dispatch(next)
    setOpen(false)
  }

  return (
    <PillWrap variant={variant} first={first}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={<ComposerControl className={variant === 'menu' ? 'w-full justify-start' : undefined} />}
        >
          <ComposerControlIcon icon={icon} />
          {optionLabel(options, displayed)}
          <ComposerControlChevron />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} style={{ zIndex: 60 }} className="outline-none">
            <Popover.Popup
              ref={popupRef}
              className={cn(
                'min-w-[168px] origin-[var(--transform-origin)] rounded-control border border-devdeck-border-menu bg-devdeck-glass-solid p-1.5',
                'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
                'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              )}
            >
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => choose(option.value)}
                  className={cn(
                    'flex h-8 w-full cursor-pointer select-none items-center rounded-md px-2.5 text-left font-mono text-xs outline-none',
                    'text-devdeck-fg-2 hover:bg-white/[0.05] hover:text-devdeck-fg',
                    option.value === displayed && 'text-devdeck-fg',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </PillWrap>
  )
}

/** Model, Effort, Interaction mode, Runtime mode — in that order, matching
 *  the design spec's mock row. */
export function ComposerControls({
  model,
  onModelChange,
  effort,
  onEffortChange,
  interactionMode,
  setInteractionMode,
  runtimeMode,
  setRuntimeMode,
  error,
  variant = 'inline',
}: ComposerControlsProps) {
  return (
    <>
      <Pill icon={Sparkles} options={MODEL_OPTIONS} value={model} dispatch={onModelChange} error={null} variant={variant} first />
      <Pill icon={Gauge} options={EFFORT_OPTIONS} value={effort} dispatch={onEffortChange} error={null} variant={variant} />
      <Pill
        icon={Hammer}
        options={INTERACTION_MODE_OPTIONS}
        value={interactionMode}
        dispatch={setInteractionMode}
        error={error}
        variant={variant}
      />
      <Pill icon={Lock} options={RUNTIME_MODE_OPTIONS} value={runtimeMode} dispatch={setRuntimeMode} error={error} variant={variant} />
    </>
  )
}
