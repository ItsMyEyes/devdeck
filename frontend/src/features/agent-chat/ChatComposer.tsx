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
import { MoreHorizontal, Square } from 'lucide-react'
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
  /** Everything `ComposerControls` needs except `variant`, which this
   *  component sets per copy of the row. Passed as one object rather than
   *  eight flat props so adding a control doesn't ripple through
   *  `AgentChatPane` → `ChatComposer` → `ComposerControls`. */
  controls: Omit<ComposerControlsProps, 'variant'>
}

export function ChatComposer({ status, onSend, onAbort, worktree, branch, controls }: ChatComposerProps) {
  const [text, setText] = useState('')

  // The adapter owns the thread-status → ChatStatus mapping, so "is the agent
  // generating" has one definition. `PromptInputSubmit` is deliberately NOT
  // given it: that component makes itself the stop control for both generating
  // states, and a click must always send — the backend allows a follow-up
  // message to steer an in-flight turn, and `waiting` is precisely the state
  // where the user has something to say. The interrupt is its own control.
  const chatStatus = promptChatStatus({ ...emptyThreadView(), status })
  const generating = chatStatus === 'streaming' || chatStatus === 'submitted'

  function handleSubmit(message: PromptInputMessage) {
    const trimmed = (message.text ?? '').trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className="flex flex-none flex-col border-t border-devdeck-line bg-devdeck-pane">
      {/* `PromptInput` spreads className onto its <form> only — its child
          `InputGroup` is hardcoded to `overflow-hidden`, so the box the user
          actually sees is out of reach from here. Styling the form as well
          produced two concentric borders with the inner one on `--input`
          (`--devdeck-line`, a hard 3:1 grey) over a `bg-input/30` wash. So the
          form paints nothing and the vendored box is re-pointed through
          descendant utilities. `bg` carries the important flag because
          `dark:bg-input/30` has the same specificity as the override; the
          others out-specify their base rule and leave the focus ring intact. */}
      <PromptInput
        onSubmit={handleSubmit}
        className={cn(
          '@container/composer mx-3 mt-2.5 mb-2',
          '[&>[data-slot=input-group]]:rounded-lg [&>[data-slot=input-group]]:border-devdeck-hairline',
          '[&>[data-slot=input-group]]:bg-devdeck-raised! [&>[data-slot=input-group]]:shadow-none',
        )}
      >
        <PromptInputBody>
          <PromptInputTextarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Ask for follow-up changes… (Enter to send, Shift+Enter for a new line)"
            className="font-mono text-[12.5px]"
          />
        </PromptInputBody>

        <PromptInputFooter>
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

          {generating ? (
            <PromptInputButton
              aria-label="Stop"
              className="bg-devdeck-red-tint text-devdeck-err hover:bg-devdeck-red-tint-hover hover:text-devdeck-err"
              onClick={onAbort}
              title="Interrupt this turn"
            >
              <Square size={12} aria-hidden="true" />
            </PromptInputButton>
          ) : null}

          <PromptInputSubmit status={chatStatus === 'error' ? 'error' : 'ready'} disabled={text.trim().length === 0} />
        </PromptInputFooter>
      </PromptInput>

      <ChatStatusStrip worktree={worktree ?? '—'} branch={branch} />
    </div>
  )
}
