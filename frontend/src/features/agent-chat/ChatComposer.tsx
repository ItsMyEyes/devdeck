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
 * `PromptInputSubmit` swaps itself to a `type="button"` stop control while the
 * status is `streaming`. That combination is what keeps "steer an in-flight
 * turn with Enter" working while the button reads as an interrupt.
 *
 * The `@container/composer` dual render of `ComposerControls` stays.
 * `PromptInputTools` is a flex row with no overflow collapsing of its own, so
 * removing the second copy would bring back the four-wrapped-rows bug. The
 * pills also stay on `@base-ui/react`, because they carry
 * `useNativeOverlayBlocker` for the Tauri webview.
 */
import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  PromptInput,
  PromptInputBody,
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

  // PromptInputSubmit reads a ChatStatus, not this app's thread status. Route
  // it through the same mapping the adapter unit-tests, so "which button does
  // the user see" has one definition.
  const chatStatus = promptChatStatus({ ...emptyThreadView(), status })

  function handleSubmit(message: PromptInputMessage) {
    const trimmed = (message.text ?? '').trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className="flex flex-none flex-col border-t border-devdeck-line bg-devdeck-pane">
      <PromptInput
        onSubmit={handleSubmit}
        className="@container/composer mx-3 mt-2.5 mb-2 rounded-lg border border-devdeck-hairline bg-devdeck-raised"
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

          <PromptInputSubmit status={chatStatus} onStop={onAbort} disabled={chatStatus === 'ready' && text.trim().length === 0} />
        </PromptInputFooter>
      </PromptInput>

      <ChatStatusStrip worktree={worktree ?? '—'} branch={branch} />
    </div>
  )
}
