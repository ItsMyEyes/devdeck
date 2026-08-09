/**
 * Pane shell for one agent-chat thread: owns `useAgentChatSocket` (the WS
 * lifecycle + streamed view model) and composes ChatHeader /
 * MessagesTimeline / ChatComposer around it. Renders the three explicit
 * states `.claude/rules/frontend.md` requires for every data surface —
 * connecting (loading), a thread error, and no-messages-yet (empty) —
 * before falling through to the real timeline.
 */
import { lazy, Suspense, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { ChatComposer } from '@/features/agent-chat/ChatComposer'
import { ChatHeader } from '@/features/agent-chat/ChatHeader'
import { EFFORT_OPTIONS, MODEL_OPTIONS } from '@/features/agent-chat/ComposerControls'
import { useAgentChatSocket } from '@/features/agent-chat/useAgentChatSocket'
import type { InteractionMode, RuntimeMode } from '@/features/agent-chat/useAgentChatSocket'
import type { Machine } from '@/store/types'

const DEFAULT_MODEL = MODEL_OPTIONS[0].value
const DEFAULT_EFFORT = EFFORT_OPTIONS[0].value

/**
 * Loaded on demand, and it has to be: `MessagesTimeline` reaches the vendored
 * `message.tsx` / `reasoning.tsx`, which import `@streamdown/math` and
 * `@streamdown/mermaid` unconditionally — katex + mermaid + their closure, and
 * they are vendored files this plan does not edit. Imported statically they
 * landed in the eagerly-loaded `/w/$wsId` chunk graph, so every visitor to a
 * workspace downloaded ~0.9 MB of markdown machinery whether or not they ever
 * opened a chat pane (and this deployment sits behind a tunnel). Behind this
 * boundary it arrives with the first transcript instead.
 */
const MessagesTimeline = lazy(async () => ({
  default: (await import('@/features/agent-chat/MessagesTimeline')).MessagesTimeline,
}))

export interface AgentChatPaneProps {
  worktreeId: string
  threadKey: string
  machine: Machine
  /** Shown in the composer's status strip. Resolved by the caller, which
   *  already holds the Worktree row — this component only has an id. */
  worktreeLabel?: string
  branch?: string | null
}

/** A whole-pane state (connecting, thread error, transcript still loading).
 *  The explicit `min-h` is load-bearing: `ConversationContent` is an
 *  auto-height block inside `use-stick-to-bottom`'s scroller, so `flex-1` has
 *  no free space to claim and `items-center` would centre a one-line-tall box —
 *  the message would sit at the top of an empty pane. Same height the
 *  `ConversationEmptyState` below is given, for the same reason. */
function PaneMessage({ tone = 'neutral', children }: { tone?: 'neutral' | 'error'; children: ReactNode }) {
  return (
    <div
      className={
        tone === 'error'
          ? 'flex min-h-[220px] flex-1 items-center justify-center px-6 text-center font-mono text-[12.5px] text-devdeck-err'
          : 'flex min-h-[220px] flex-1 items-center justify-center px-6 text-center font-mono text-[12.5px] text-devdeck-fg-2'
      }
    >
      {children}
    </div>
  )
}

export function AgentChatPane({ worktreeId, threadKey, machine, worktreeLabel, branch }: AgentChatPaneProps) {
  const { view, status, sendTurn, abortTurn, setRuntimeMode, setInteractionMode } =
    useAgentChatSocket({ machine, threadKey })

  // Model and effort ride the next `thread.turn.start` payload, so they are
  // local until a turn is sent. Runtime and interaction mode dispatch
  // immediately — they change how the agent behaves for the whole thread, not
  // just the next message — so the pill's displayed value is optimistic and
  // `ComposerControls` reverts it if an error frame arrives.
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [effort, setEffort] = useState(DEFAULT_EFFORT)
  const [runtimeMode, setRuntimeModeValue] = useState<RuntimeMode>('approval-required')
  const [interactionMode, setInteractionModeValue] = useState<InteractionMode>('default')

  const controls = useMemo(
    () => ({
      model,
      onModelChange: setModel,
      effort,
      onEffortChange: setEffort,
      interactionMode,
      setInteractionMode: (mode: InteractionMode) => {
        setInteractionModeValue(mode)
        setInteractionMode(mode)
      },
      runtimeMode,
      setRuntimeMode: (mode: RuntimeMode) => {
        setRuntimeModeValue(mode)
        setRuntimeMode(mode)
      },
      error: view.error,
    }),
    [model, effort, interactionMode, runtimeMode, view.error, setInteractionMode, setRuntimeMode],
  )

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

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="p-0">
          {showConnecting ? (
            <PaneMessage>Connecting to the agent…</PaneMessage>
          ) : view.error ? (
            <PaneMessage tone="error">{view.error}</PaneMessage>
          ) : view.items.length === 0 ? (
            <ConversationEmptyState
              className="min-h-[220px]"
              icon={<MessageSquare className="size-5 text-devdeck-fg-2" aria-hidden="true" />}
              title="No messages yet"
              description="Say hello below to start the thread."
            />
          ) : (
            <Suspense fallback={<PaneMessage>Loading the transcript…</PaneMessage>}>
              <MessagesTimeline view={view} />
            </Suspense>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <ChatComposer
        status={view.status}
        onSend={sendTurn}
        onAbort={abortTurn}
        controls={controls}
        worktree={worktreeLabel}
        branch={branch}
      />
    </div>
  )
}
