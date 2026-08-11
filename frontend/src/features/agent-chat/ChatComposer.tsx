/**
 * Chat input, t3code layout: the textarea and the control row live inside
 * one bordered box, a status strip sits below it. Enter sends, Shift+Enter
 * inserts a newline; sending is never disabled by `status === 'running'` —
 * the decider explicitly allows a follow-up message to "steer" an
 * in-flight turn (see the design note on `CmdThreadTurnStart` in
 * `backend/internal/agentcore/orchestration/engine.go`'s `Decide`), so
 * gating Send on idle would silently reject something the backend already
 * supports.
 *
 * Two placements, one component. `variant="docked"` is the composer a live
 * thread scrolls above; `variant="hero"` is the same box parked in the middle
 * of an empty thread under "What should we build in …?" — no top border, no
 * status strip, nothing to divide it from the heading it belongs to. Both
 * share the transcript's `max-w-3xl` measure so the box never sits wider than
 * the messages it produces.
 *
 * The mode/model pills come from `ComposerControls`, which owns their
 * options and dispatches the real commands. The row is rendered twice —
 * once inline (shown above the `@sm/composer` container breakpoint) and
 * once inside the "More controls" overflow popup (shown below it) —
 * mirroring `BrowserToolbar.tsx`'s existing pattern for the same problem:
 * wrapping must be structurally impossible, not merely unlikely, so the
 * escape hatch is a second real copy of the row rather than JS-measured
 * hiding. Four `Select`s in a `flex-wrap` row is what this replaced, and
 * it stacked into four full-width rows in any real pane width.
 *
 * Built on the vendored `PromptInput`. `PromptInputTextarea` owns the
 * Enter/Shift+Enter contract (it calls `form.requestSubmit()` directly), and
 * the submit button stays a real submit in every state, with the interrupt
 * rendered beside it while the agent is generating. `PromptInputSubmit` can
 * turn ITSELF into the stop control, but it does so for `waiting` as well as
 * `streaming` — and `waiting` is the state where the agent is asking the user
 * something, i.e. exactly when a click must send.
 *
 * The `@container/composer` dual render of `ComposerControls` stays.
 * `PromptInputTools` is a flex row with no overflow collapsing of its own, so
 * removing the second copy would bring back the four-wrapped-rows bug. The
 * pills also stay on `@base-ui/react`, because they carry
 * `useNativeOverlayBlocker` for the Tauri webview.
 */
import { useState } from 'react'
import { ArrowUp, MoreHorizontal, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { promptChatStatus } from '@/features/agent-chat/adapter'
import { ChatStatusStrip } from '@/features/agent-chat/ChatStatusStrip'
import { composerControlClassName } from '@/features/agent-chat/ComposerControl'
import { ComposerControls } from '@/features/agent-chat/ComposerControls'
import type { ComposerControlsProps } from '@/features/agent-chat/ComposerControls'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'
import type { AgentThreadView } from '@/features/agent-chat/types'

export interface ChatComposerProps {
  status: AgentThreadView['status']
  onSend: (text: string) => void
  onAbort: () => void
  worktree?: string
  branch?: string | null
  /** `'docked'` (default) pins the composer under a live transcript;
   *  `'hero'` centres it in an empty thread. See the file's doc comment. */
  variant?: 'docked' | 'hero'
  /** Everything `ComposerControls` needs except `variant`, which this
   *  component sets per copy of the row. Passed as one object rather than
   *  eight flat props so adding a control doesn't ripple through
   *  `AgentChatPane` → `ChatComposer` → `ComposerControls`. */
  controls: Omit<ComposerControlsProps, 'variant'>
}

/** The vendored `InputGroup` hardcodes its own `className` (`rounded-md`,
 *  `border-input`, `dark:bg-input/30`, `shadow-xs`) and `PromptInput` spreads
 *  ours onto the `<form>` only — so the box the user actually sees is out of
 *  reach from here and has to be re-pointed through descendant utilities.
 *  Left alone it painted two concentric borders, the inner one a hard 3:1
 *  grey over a washed-out fill.
 *
 *  `bg` carries the important flag because `dark:bg-input/30` has the same
 *  specificity as the override; the others out-specify their base rule, which
 *  leaves the focus ring (`has-[…:focus-visible]:`) intact. */
const BOX = [
  '[&>[data-slot=input-group]]:rounded-xl',
  '[&>[data-slot=input-group]]:border-devdeck-hairline',
  '[&>[data-slot=input-group]]:bg-devdeck-raised!',
  '[&>[data-slot=input-group]]:shadow-none',
  // The vendored padding is tuned for a one-line input; this is a message box.
  '[&_[data-slot=input-group-control]]:px-4',
  '[&_[data-slot=input-group-control]]:pt-3.5',
  // The vendored focus state is a 3px ring PLUS an accent border. On a
  // control this large that is a glowing slab, not a focus indicator — the
  // accent border alone already reads at a glance. 1px keeps the ring
  // visible for anyone who needs the extra edge without the halo.
  '[&>[data-slot=input-group]]:has-[[data-slot=input-group-control]:focus-visible]:ring-1',
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

export function ChatComposer({ status, onSend, onAbort, worktree, branch, controls, variant = 'docked' }: ChatComposerProps) {
  const [text, setText] = useState('')
  const hero = variant === 'hero'

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

  function handleSubmit(message: PromptInputMessage) {
    const trimmed = (message.text ?? '').trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className={cn('flex flex-none flex-col', hero ? 'w-full' : 'border-t border-devdeck-hairline bg-devdeck-pane')}>
      <PromptInput
        onSubmit={handleSubmit}
        className={cn('@container/composer mx-auto w-full max-w-3xl', hero ? 'px-0' : 'px-5 pt-3 pb-2', BOX)}
      >
        <PromptInputBody>
          <PromptInputTextarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={hero ? 'Ask for changes, or describe what to build' : 'Ask anything…'}
            className="text-[14px] leading-relaxed placeholder:text-devdeck-fg-2"
          />
        </PromptInputBody>

        <PromptInputFooter className="gap-2">
          <PromptInputTools className="min-w-0 flex-1 overflow-hidden">
            <div
              data-testid="composer-controls-inline"
              className="hidden min-w-0 flex-nowrap items-center gap-0.5 overflow-hidden @sm/composer:flex"
            >
              <ComposerControls {...controls} variant="inline" />
            </div>
            <div className="@sm/composer:hidden">
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
          </PromptInputTools>

          {interrupting ? (
            <PromptInputButton aria-label="Stop" className={STOP} onClick={onAbort} title="Interrupt this turn">
              <Square size={11} fill="currentColor" aria-hidden="true" />
            </PromptInputButton>
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
        </PromptInputFooter>
      </PromptInput>

      {hero ? null : <ChatStatusStrip worktree={worktree ?? '—'} branch={branch} />}
    </div>
  )
}
