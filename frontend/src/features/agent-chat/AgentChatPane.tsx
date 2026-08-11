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
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { ChatComposer } from '@/features/agent-chat/ChatComposer'
import { ChatHeader } from '@/features/agent-chat/ChatHeader'
import { EFFORT_OPTIONS } from '@/features/agent-chat/ComposerControls'
import { instanceIdForAgent } from '@/features/agent-chat/ModelPicker'
import type { ModelChoice } from '@/features/agent-chat/ModelPicker'
import { useAgentChatSocket } from '@/features/agent-chat/useAgentChatSocket'
import type { InteractionMode, RuntimeMode, TurnModelSelection } from '@/features/agent-chat/useAgentChatSocket'
import type { Machine } from '@/store/types'

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
  /** The CLI agent this worktree runs (`Worktree.agent`). The model picker's
   *  default rail, and the agent a turn runs on unless the picker names
   *  another one. */
  agentId?: string
}

/**
 * Builds the turn's `provider.ModelSelection`, or `undefined` for "leave
 * everything to the worktree's own agent" — which is what every turn did
 * before the picker existed, and still the right payload when the operator
 * has touched nothing.
 *
 * `instanceId` is only set once a model is actually picked. Sending the
 * worktree's own agent unconditionally would look harmless but is not: the
 * reactor treats a named instance as "make sure the thread is on this one",
 * and a thread the operator had deliberately switched would be yanked back on
 * its next turn.
 */
function turnModel(model: ModelChoice | null, effort: string): TurnModelSelection | undefined {
  const [level, thinking] = effort.split(':')
  const options: Record<string, unknown> = {}
  if (level) options.effort = level
  if (thinking) options.thinking = thinking

  if (!model) return Object.keys(options).length > 0 ? { options } : undefined
  return { instanceId: instanceIdForAgent(model.agentId), model: model.modelId, options }
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
          ? 'flex min-h-[220px] flex-1 items-center justify-center px-6 text-center text-[13px] text-devdeck-err'
          : 'flex min-h-[220px] flex-1 items-center justify-center px-6 text-center text-[13px] text-devdeck-fg-2'
      }
    >
      {children}
    </div>
  )
}

/**
 * The empty thread: one question and the composer, centred — not a
 * placeholder card above a docked input. A new thread has exactly one thing
 * to do, so the surface asks for it and puts the box to answer with directly
 * under the question.
 *
 * The composer here is the same component the live thread docks at its
 * bottom, in its `hero` placement — one implementation of Enter-to-send, the
 * control pills and the interrupt, not two that drift.
 */
function EmptyThread({ subject, composer }: { subject?: string; composer: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-8">
      <div className="flex w-full max-w-3xl flex-col">
        <h2 className="mb-6 text-center text-[26px] leading-tight font-medium tracking-tight text-devdeck-fg">
          What should we build
          {subject ? (
            <>
              {' in '}
              <span className="underline decoration-devdeck-line decoration-1 underline-offset-[6px]">{subject}</span>
            </>
          ) : null}
          ?
        </h2>
        {composer}
      </div>
    </div>
  )
}

export function AgentChatPane({ worktreeId, threadKey, machine, worktreeLabel, branch, agentId = 'claude' }: AgentChatPaneProps) {
  const { view, status, sendTurn, abortTurn, setRuntimeMode, setInteractionMode } =
    useAgentChatSocket({ machine, threadKey })

  // Model and effort ride the next `thread.turn.start` payload, so they are
  // local until a turn is sent. Runtime and interaction mode dispatch
  // immediately — they change how the agent behaves for the whole thread, not
  // just the next message — so the pill's displayed value is optimistic and
  // `ComposerControls` reverts it if an error frame arrives.
  // `null` = run the worktree's configured agent on its own default model,
  // which is what every thread did before the picker existed. Only once the
  // operator picks something does a ModelSelection ride the turn.
  const [model, setModel] = useState<ModelChoice | null>(null)
  const [effort, setEffort] = useState(DEFAULT_EFFORT)
  const [runtimeMode, setRuntimeModeValue] = useState<RuntimeMode>('approval-required')
  const [interactionMode, setInteractionModeValue] = useState<InteractionMode>('default')

  const controls = useMemo(
    () => ({
      model,
      onModelChange: setModel,
      machine,
      worktreeAgentId: agentId,
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
    [model, effort, machine, agentId, interactionMode, runtimeMode, view.error, setInteractionMode, setRuntimeMode],
  )

  // Only the very first connect (no replayed items yet) shows a blocking
  // "connecting" state — a reconnect mid-thread keeps the existing timeline
  // on screen instead of blanking it, matching the PTY's own reattach
  // behaviour (the engine and its SQLite log outlive the socket).
  const showConnecting = status === 'connecting' && view.items.length === 0

  // A thread with nothing in it and nothing wrong with it gets the hero
  // layout instead of a transcript with a placeholder in it.
  const isEmpty = !showConnecting && view.error === null && view.items.length === 0

  const composer = (
    <ChatComposer
      status={view.status}
      onSend={(text) => sendTurn(text, turnModel(model, effort))}
      onAbort={abortTurn}
      controls={controls}
      worktree={worktreeLabel}
      branch={branch}
      variant={isEmpty ? 'hero' : 'docked'}
    />
  )

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-devdeck-pane">
      <ChatHeader
        machine={machine}
        worktreeId={worktreeId}
        threadKey={threadKey}
        socketStatus={status}
        threadStatus={view.status}
      />

      {isEmpty ? (
        <EmptyThread subject={worktreeLabel} composer={composer} />
      ) : (
        <>
          <Conversation className="min-h-0 flex-1">
            <ConversationContent className="p-0">
              {showConnecting ? (
                <PaneMessage>Connecting to the agent…</PaneMessage>
              ) : view.error ? (
                <PaneMessage tone="error">{view.error}</PaneMessage>
              ) : (
                <Suspense fallback={<PaneMessage>Loading the transcript…</PaneMessage>}>
                  <MessagesTimeline view={view} />
                </Suspense>
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          {composer}
        </>
      )}
    </div>
  )
}
