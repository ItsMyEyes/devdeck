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
 */
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowUp, MoreHorizontal, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Textarea } from '@/components/ui/textarea'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { ChatStatusStrip } from '@/features/agent-chat/ChatStatusStrip'
import { composerControlClassName } from '@/features/agent-chat/ComposerControl'
import { ComposerControls } from '@/features/agent-chat/ComposerControls'
import type { ComposerControlsProps } from '@/features/agent-chat/ComposerControls'
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
  const running = status === 'running'

  function send() {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="flex flex-none flex-col border-t border-devdeck-line bg-devdeck-pane">
      <div className="@container/composer mx-3 mt-2.5 mb-2 flex flex-col gap-2 rounded-lg border border-devdeck-border-strong bg-devdeck-pane px-2.5 py-2">
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask for follow-up changes… (Enter to send, Shift+Enter for a new line)"
          rows={2}
          className="border-0 bg-transparent px-0 py-0 focus-visible:ring-0"
        />

        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center overflow-hidden">
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
          </div>

          <button
            type="button"
            onClick={running ? onAbort : send}
            disabled={!running && !text.trim()}
            aria-label={running ? 'Interrupt' : 'Send'}
            title={running ? 'Interrupt' : 'Send'}
            className={cn(
              'flex size-7 flex-none items-center justify-center rounded-full transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-40',
              running
                ? 'bg-devdeck-red-tint text-devdeck-err hover:bg-devdeck-red-tint-hover'
                : 'bg-devdeck-accent text-devdeck-accent-ink hover:bg-devdeck-accent-hover',
            )}
          >
            {running ? <Square size={12} fill="currentColor" aria-hidden="true" /> : <ArrowUp size={14} strokeWidth={2.5} aria-hidden="true" />}
          </button>
        </div>
      </div>

      <ChatStatusStrip worktree={worktree ?? '—'} branch={branch} />
    </div>
  )
}
