/**
 * Pane shell for one agent-chat thread: owns `useAgentChatSocket` (the WS
 * lifecycle + streamed view model) and composes ChatHeader /
 * MessagesTimeline / ChatComposer around it. Renders the three explicit
 * states `.claude/rules/frontend.md` requires for every data surface —
 * connecting (loading), a thread error, and no-messages-yet (empty) —
 * before falling through to the real timeline.
 */
import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { ChatComposer } from '@/features/agent-chat/ChatComposer'
import { ChatHeader } from '@/features/agent-chat/ChatHeader'
import { MessagesTimeline } from '@/features/agent-chat/MessagesTimeline'
import { shouldFollow } from '@/features/agent-chat/scrollAnchoring'
import { useAgentChatSocket } from '@/features/agent-chat/useAgentChatSocket'
import type { Machine } from '@/store/types'

export interface AgentChatPaneProps {
  worktreeId: string
  threadKey: string
  machine: Machine
}

function PaneMessage({ tone = 'neutral', children }: { tone?: 'neutral' | 'error'; children: ReactNode }) {
  return (
    <div
      className={
        tone === 'error'
          ? 'flex flex-1 items-center justify-center px-6 text-center font-mono text-[12.5px] text-devdeck-err'
          : 'flex flex-1 items-center justify-center px-6 text-center font-mono text-[12.5px] text-devdeck-fg-2'
      }
    >
      {children}
    </div>
  )
}

export function AgentChatPane({ worktreeId, threadKey, machine }: AgentChatPaneProps) {
  const { view, status, sendTurn, abortTurn } = useAgentChatSocket({ machine, threadKey })

  // Follow-mode: sticks the timeline to the bottom as deltas stream in,
  // unless the user has scrolled up to read history past the re-arm band
  // `shouldFollow` defines — see scrollAnchoring.ts's doc comment for why a
  // strict "at the very bottom" check isn't enough.
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    followRef.current = shouldFollow(
      { contentLength: el.scrollHeight, scroll: el.scrollTop, scrollLength: el.clientHeight },
      0,
    )
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !followRef.current) return
    el.scrollTop = el.scrollHeight
  }, [view.items])

  // Only the very first connect (no replayed items yet) shows a blocking
  // "connecting" state — a reconnect mid-thread keeps the existing timeline
  // on screen instead of blanking it, matching the PTY's own reattach
  // behaviour (the engine and its SQLite log outlive the socket).
  const showConnecting = status === 'connecting' && view.items.length === 0

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-devdeck-pane">
      <ChatHeader
        machine={machine}
        worktreeId={worktreeId}
        threadKey={threadKey}
        socketStatus={status}
        threadStatus={view.status}
      />

      <div ref={scrollRef} onScroll={handleScroll} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {showConnecting ? (
          <PaneMessage>Connecting to the agent…</PaneMessage>
        ) : view.error ? (
          <PaneMessage tone="error">{view.error}</PaneMessage>
        ) : view.items.length === 0 ? (
          <PaneMessage>No messages yet — say hello below.</PaneMessage>
        ) : (
          <MessagesTimeline view={view} />
        )}
      </div>

      <ChatComposer status={view.status} onSend={sendTurn} onAbort={abortTurn} />
    </div>
  )
}
