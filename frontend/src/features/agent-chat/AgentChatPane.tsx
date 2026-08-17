/**
 * Pane shell for one agent-chat thread: owns `useAgentChatSocket` (the WS
 * lifecycle + streamed view model) and composes ChatHeader /
 * MessagesTimeline / ChatComposer around it. Renders the three explicit
 * states `.claude/rules/frontend.md` requires for every data surface —
 * connecting (loading), a thread error, and no-messages-yet (empty) —
 * before falling through to the real timeline.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, CircleStop, PackageX, WifiOff } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { ChatComposer } from '@/features/agent-chat/ChatComposer'
import { ChatHeader } from '@/features/agent-chat/ChatHeader'
import { activeBannerIds, composerBanners } from '@/features/agent-chat/composerBanners'
import type { ComposerBannerIconKey } from '@/features/agent-chat/composerBanners'
import type { ComposerBannerStackItem } from '@/features/agent-chat/ComposerBannerStack'
import type { AgentAttachmentRef } from '@/features/agent-chat/ComposerAttachments'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_EFFORT } from '@/features/agent-chat/ComposerControls'
import { instanceIdForAgent } from '@/features/agent-chat/ModelPicker'
import type { ModelChoice } from '@/features/agent-chat/ModelPicker'
import { latestProposedPlan } from '@/features/agent-chat/plan'
import type { PlanFollowUpSubmission } from '@/features/agent-chat/planMarkdown'
import { useAgentChatSocket } from '@/features/agent-chat/useAgentChatSocket'
import type { AgentChatTarget, InteractionMode, RuntimeMode, TurnModelSelection } from '@/features/agent-chat/useAgentChatSocket'
import { useAgents, useAgentThreads } from '@/features/data/queries'
import type { Machine } from '@/store/types'

/** icon key → glyph — the only place `composerBanners`' output (icon-agnostic
 *  on purpose, spec Design §4) becomes a `ReactNode`. */
const BANNER_ICONS: Record<ComposerBannerIconKey, LucideIcon> = {
  connection: WifiOff,
  'transport-error': AlertTriangle,
  'agent-missing': PackageX,
  'session-stopped': CircleStop,
}

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
  /** Names the backend that hosts this thread's socket — see
   *  `AgentChatTarget`'s doc comment (`useAgentChatSocket.ts`). Every
   *  worktree call site passes `{ kind: 'machine', machine }`; an SSH
   *  thread (design spec `2026-08-17-ssh-devops-chat-design.md` §3.3)
   *  passes `{ kind: 'hub' }` and, having no worktree at all, leaves
   *  `worktreeId`/`branch`/`worktreeLabel`/`agentId` unset. */
  target: AgentChatTarget
  /** Absent for an SSH thread — it has no worktree. */
  worktreeId?: string
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
 *
 * `effort`/`contextWindow` ride straight through as `--effort`/`--autocompact`
 * (see buildArgs in claude/adapter.go) — both real CLI flags, confirmed
 * against `claude --help`. `ultrathink` has no `--effort` value of its own,
 * so it rides on `max`, the closest real level; see ComposerControls.tsx's
 * `REASONING_OPTIONS` doc comment for why.
 */
function turnModel(model: ModelChoice | null, effort: string, contextWindow: string): TurnModelSelection | undefined {
  const options: Record<string, unknown> = {
    effort: effort === 'ultrathink' ? 'max' : effort,
    contextWindow,
  }

  if (!model) return { options }
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

export function AgentChatPane({ target, worktreeId, threadKey, machine, worktreeLabel, branch, agentId = 'claude' }: AgentChatPaneProps) {
  // Draft-thread connect gate (design spec §4, plan Task 10). `threadExists`
  // reads the same sidebar-backing query `SessionsPanel` already populates
  // (`features/data/queries.ts:1380`), so the path that matters — the
  // operator just clicked "New session" from a panel rendered off that same
  // query — costs no extra request. Fail open (loading or errored both
  // resolve `true`): a stray empty thread row is a far cheaper failure than
  // a real thread whose transcript never loads.
  const threadsQuery = useAgentThreads(machine, worktreeId)
  // Flips permanently once this pane has sent a turn, so a `useAgentThreads`
  // cache that hasn't caught up with the row it just caused can't flap the
  // gate back to `false` mid-turn.
  const [hasSentThisSession, setHasSentThisSession] = useState(false)
  const threadExists = (threadsQuery.data ?? []).some((thread) => thread.id === threadKey)
  const connect = hasSentThisSession || threadExists || threadsQuery.isLoading || threadsQuery.isError

  const {
    view,
    status,
    sendTurn,
    abortTurn,
    setRuntimeMode,
    setInteractionMode,
    respondToUserInput,
    respondToApproval,
    clearError,
  } = useAgentChatSocket({ target, threadKey, connect })
  const agents = useAgents(machine)

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
  // Same "rides the next turn" rule as effort — see the comment above.
  const [contextWindow, setContextWindow] = useState(DEFAULT_CONTEXT_WINDOW)
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
      contextWindow,
      onContextWindowChange: setContextWindow,
      contextTokens: view.contextTokens,
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
    [
      model,
      effort,
      contextWindow,
      machine,
      agentId,
      interactionMode,
      runtimeMode,
      view.error,
      view.contextTokens,
      setInteractionMode,
      setRuntimeMode,
    ],
  )

  // Only the very first connect (no replayed items yet) shows a blocking
  // "connecting" state — a reconnect mid-thread keeps the existing timeline
  // on screen instead of blanking it, matching the PTY's own reattach
  // behaviour (the engine and its SQLite log outlive the socket).
  const showConnecting = status === 'connecting' && view.items.length === 0

  // A thread with nothing in it gets the hero layout instead of a transcript
  // with a placeholder in it — even when it also can't connect: `isEmpty`
  // drops its old `view.error === null` clause (spec Design §7) so a
  // brand-new thread that fails to connect keeps its framing, with a banner
  // above the composer instead of losing the hero entirely.
  const isEmpty = !showConnecting && view.items.length === 0

  // F3/F4 dismissals (spec Design §4, "Dismissal bookkeeping") — local,
  // pruned against `activeBannerIds` below so a later recurrence of the same
  // condition (same stable id) shows again instead of staying hidden
  // forever. F1 needs none (not dismissible); F2 needs none (dismissal
  // clears its source via `clearError`).
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())

  const bannerInputs = useMemo(
    () => ({
      threadKey,
      machineId: machine.id,
      machineName: machine.name,
      agentId,
      socketStatus: status,
      showConnecting,
      hasTranscript: view.items.length > 0,
      threadError: view.error,
      threadStatus: view.status,
      agents,
    }),
    [threadKey, machine.id, machine.name, agentId, status, showConnecting, view.items.length, view.error, view.status, agents],
  )

  useEffect(() => {
    const active = activeBannerIds(bannerInputs)
    setDismissed((prev) => {
      const pruned = new Set([...prev].filter((id) => active.has(id)))
      return pruned.size === prev.size ? prev : pruned
    })
  }, [bannerInputs])

  // T1's module stays icon-agnostic; this is the one place a decision turns
  // into a `ReactNode` icon and an `onDismiss` closure (spec Design §4). F2
  // clears its source (`clearError`); F3/F4 dismiss locally.
  const bannerItems: ComposerBannerStackItem[] = composerBanners({ ...bannerInputs, dismissed }).map((spec) => {
    const Icon = BANNER_ICONS[spec.iconKey]
    const onDismiss = !spec.dismissible
      ? undefined
      : spec.id.startsWith('thread-error:')
        ? clearError
        : () => setDismissed((prev) => new Set(prev).add(spec.id))
    return {
      id: spec.id,
      tone: spec.tone,
      icon: <Icon aria-hidden="true" />,
      title: spec.title,
      description: spec.description,
      onDismiss,
    }
  })

  // The first send is also what flips the connect gate open (comment above)
  // — set the flag before dispatching so the very next render already
  // reflects it, rather than trailing the outbox's own flush by a tick.
  // `attachments` is whatever `ChatComposer`'s own `ComposerAttachments`
  // finished uploading before submit — forwarded straight through, this pane
  // has no opinion about it beyond passing it on to `sendTurn`.
  function handleSend(text: string, attachments: AgentAttachmentRef[]) {
    setHasSentThisSession(true)
    sendTurn(text, turnModel(model, effort, contextWindow), attachments)
  }

  // The plan on the table, derived (never stored — plan T7's `plan.ts`) from
  // the same flat item list the transcript already renders. `EmptyThread`'s
  // hero composer gets `null` here for free: an empty thread has no items,
  // so there is nothing to derive.
  const plan = latestProposedPlan(view.items)

  // T12 — the composer's plan follow-up (design spec §7). `interactionMode`
  // and its setter, and `sendTurn` via `handleSend`, all already exist above
  // (`controls.setInteractionMode` and `handleSend`) — Implement is exactly
  // "switch mode, then send", conditioned on the mode actually needing to
  // change so Refine (whose `mode` is always the current 'plan') never
  // dispatches a redundant `thread.interaction-mode.set`.
  function handlePlanFollowUp(submission: PlanFollowUpSubmission) {
    if (submission.mode !== interactionMode) {
      setInteractionModeValue(submission.mode)
      setInteractionMode(submission.mode)
    }
    // A plan follow-up sends canned text, never a user's own attachment —
    // ChatComposer's own attachment strip belongs to `submit()`, not this
    // bypass (design spec §7 makes no mention of the two combining).
    handleSend(submission.text, [])
  }

  const composer = (
    <ChatComposer
      status={view.status}
      onSend={handleSend}
      onAbort={abortTurn}
      controls={controls}
      machine={machine}
      worktreeId={worktreeId}
      worktree={worktreeLabel}
      branch={branch}
      variant={isEmpty ? 'hero' : 'docked'}
      threadKey={threadKey}
      pendingUserInputs={view.pendingUserInputs}
      onRespondToUserInput={respondToUserInput}
      pendingApprovals={view.pendingApprovals}
      onRespondToApproval={respondToApproval}
      plan={plan}
      onPlanFollowUp={handlePlanFollowUp}
      banners={bannerItems}
    />
  )

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-devdeck-pane">
      <ChatHeader
        machine={machine}
        // ChatHeader's suffix badge (`extraThreadSuffix`) compares this
        // against `threadKey`; an SSH thread has no worktree, so `''` reads
        // as "no primary id to strip" rather than a false badge. ChatHeader
        // itself is out of scope here — see Task 12 for a real SSH header.
        worktreeId={worktreeId ?? ''}
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
              ) : (
                <Suspense fallback={<PaneMessage>Loading the transcript…</PaneMessage>}>
                  <MessagesTimeline view={view} machine={machine} />
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
