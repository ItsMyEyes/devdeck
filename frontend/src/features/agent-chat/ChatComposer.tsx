/**
 * Chat input: Enter sends, Shift+Enter inserts a newline, Abort appears
 * only while the thread is actively running a turn. Sending is never
 * disabled by `status === 'running'` — the decider explicitly allows a
 * follow-up message to "steer" an in-flight turn (see the design note on
 * `CmdThreadTurnStart` in `backend/internal/agentcore/orchestration/engine.go`'s
 * `Decide`), so gating Send on idle would silently reject something the
 * backend already supports.
 */
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { AgentThreadView } from '@/features/agent-chat/types'

export interface ChatComposerProps {
  status: AgentThreadView['status']
  onSend: (text: string) => void
  onAbort: () => void
}

export function ChatComposer({ status, onSend, onAbort }: ChatComposerProps) {
  const [text, setText] = useState('')

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
    <div className="flex flex-none flex-col gap-2 border-t border-devdeck-line bg-devdeck-pane px-3 py-2.5">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message the agent… (Enter to send, Shift+Enter for a new line)"
        rows={3}
      />
      <div className="flex items-center justify-end gap-2">
        {status === 'running' ? (
          <Button variant="destructive" size="sm" onClick={onAbort}>
            <Square size={13} />
            Abort
          </Button>
        ) : null}
        <Button variant="default" size="sm" onClick={send} disabled={!text.trim()}>
          <Send size={13} />
          Send
        </Button>
      </div>
    </div>
  )
}
