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
 * The four mode/model pills are structural placeholders in this task —
 * Task 6 is layout only. They render `disabled`: a pill that looks
 * interactive but dispatches nothing is exactly the "controls do nothing,
 * silently lie" defect this whole spec exists to remove (design spec,
 * decision 3), so until Task 7 wires real dispatch they stay visibly
 * inert rather than pretending to work. The row is rendered twice — once
 * inline (shown above the `@sm/composer` container breakpoint) and once
 * inside the "More controls" overflow popup (shown below it) — mirroring
 * `BrowserToolbar.tsx`'s existing pattern for the same problem: wrapping
 * must be structurally impossible, not merely unlikely, so the escape
 * hatch is a second real copy of the row rather than JS-measured hiding.
 *
 * `worktree` / `branch` are optional: `AgentChatPane.tsx` isn't in Task 6's
 * file list, so nothing yet resolves real worktree/branch data down to
 * this component (see `ChatStatusStrip.tsx`'s doc comment).
 */
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowUp, Gauge, Hammer, Lock, MoreHorizontal, Sparkles, Square } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Textarea } from '@/components/ui/textarea'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { ChatStatusStrip } from '@/features/agent-chat/ChatStatusStrip'
import { ComposerControl, ComposerControlChevron, ComposerControlIcon, composerControlClassName } from '@/features/agent-chat/ComposerControl'
import type { AgentThreadView } from '@/features/agent-chat/types'

export interface ChatComposerProps {
  status: AgentThreadView['status']
  onSend: (text: string) => void
  onAbort: () => void
  worktree?: string
  branch?: string | null
}

interface PlaceholderControl {
  key: string
  icon: LucideIcon
  label: string
}

/** Model, Effort (effort · thinking, one control per the design spec's
 *  table), Interaction mode, Runtime mode — in that order, matching the
 *  design spec's mock row. */
const PLACEHOLDER_CONTROLS: PlaceholderControl[] = [
  { key: 'model', icon: Sparkles, label: 'Sonnet 5' },
  { key: 'effort', icon: Gauge, label: 'High · Normal' },
  { key: 'interaction-mode', icon: Hammer, label: 'Build' },
  { key: 'runtime-mode', icon: Lock, label: 'Full access' },
]

function ControlPills({ variant }: { variant: 'inline' | 'menu' }) {
  return (
    <>
      {PLACEHOLDER_CONTROLS.map((control, index) => (
        <span key={control.key} className={cn('flex min-w-0 items-center', variant === 'inline' ? 'flex-none' : 'w-full')}>
          {variant === 'inline' && index > 0 ? (
            <span aria-hidden="true" className="mx-0.5 h-4 w-px flex-none bg-devdeck-line" />
          ) : null}
          <ComposerControl disabled className={variant === 'menu' ? 'w-full justify-start' : undefined}>
            <ComposerControlIcon icon={control.icon} />
            {control.label}
            <ComposerControlChevron />
          </ComposerControl>
        </span>
      ))}
    </>
  )
}

export function ChatComposer({ status, onSend, onAbort, worktree, branch }: ChatComposerProps) {
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
              <ControlPills variant="inline" />
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
                  <ControlPills variant="menu" />
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
