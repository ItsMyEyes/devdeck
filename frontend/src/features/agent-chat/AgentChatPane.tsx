/**
 * Pane shell for one agent-chat thread: owns `useAgentChatSocket` (the WS
 * lifecycle + streamed view model) and composes ChatHeader /
 * MessagesTimeline / ChatComposer around it. Renders the three explicit
 * states `.claude/rules/frontend.md` requires for every data surface —
 * connecting (loading), a thread error, and no-messages-yet (empty) —
 * before falling through to the real timeline.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, CircleStop, PackageX, ServerCog, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import type { LucideIcon } from 'lucide-react'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { ChatComposer } from '@/features/agent-chat/ChatComposer'
import { ChatHeader } from '@/features/agent-chat/ChatHeader'
import { activeBannerIds, composerBanners } from '@/features/agent-chat/composerBanners'
import type { ComposerBannerIconKey } from '@/features/agent-chat/composerBanners'
import type { ComposerBannerStackItem } from '@/features/agent-chat/ComposerBannerStack'
import type { AgentAttachmentRef } from '@/features/agent-chat/ComposerAttachments'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_EFFORT } from '@/features/agent-chat/ComposerControls'
import { lastTurnModel } from '@/features/agent-chat/adapter'
import { instanceIdForAgent } from '@/features/agent-chat/ModelPicker'
import type { ModelChoice } from '@/features/agent-chat/ModelPicker'
import { latestProposedPlan } from '@/features/agent-chat/plan'
import type { PlanFollowUpSubmission } from '@/features/agent-chat/planMarkdown'
import { useAgentChatSocket } from '@/features/agent-chat/useAgentChatSocket'
import type { AgentChatTarget, InteractionMode, RuntimeMode, TurnModelSelection } from '@/features/agent-chat/useAgentChatSocket'
import { useAgentModels, useAgents, useAgentThreads, useMachineCapabilities } from '@/features/data/queries'
import { agentChatSupport } from '@/features/agent-chat/agentChatSupport'
import type { MentionSource } from '@/features/agent-chat/composerMention'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { Machine } from '@/store/types'

/** icon key → glyph — the only place `composerBanners`' output (icon-agnostic
 *  on purpose, spec Design §4) becomes a `ReactNode`. */
const BANNER_ICONS: Record<ComposerBannerIconKey, LucideIcon> = {
  connection: WifiOff,
  'transport-error': AlertTriangle,
  'agent-missing': PackageX,
  'session-stopped': CircleStop,
  'runtime-unsupported': ServerCog,
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
  /** Hard veto on opening the socket, ANDed with the draft-thread gate below.
   *  Defaults to `true`, so every existing caller is unaffected.
   *
   *  It exists for panes that are mounted but not yet shown. The SSH rail
   *  keeps its chat panel mounted-but-hidden so a toggle doesn't drop the
   *  socket (`SSHRightSidebar`), which without this would mean every SSH
   *  terminal tab silently opened an agent socket and had the server
   *  auto-create a thread the operator never asked for. */
  connectEnabled?: boolean
  /** The subject this thread is about — shown in the header badge and in the
   *  empty thread's "What should we build in …?". Resolved by the caller,
   *  which already holds the Worktree (or SSH connection) row; this component
   *  only has an id. */
  worktreeLabel?: string
  /** The CLI agent this worktree runs (`Worktree.agent`). The model picker's
   *  default rail, and the agent a turn runs on unless the picker names
   *  another one. */
  agentId?: string
  /** Overrides the composer's `@` mention source (plan Task 13's
   *  `composerMention.ts`) — `SSHAgentChatPanel` passes
   *  `sshMentionSource(connectionId)` here so `@` completes absolute remote
   *  paths instead of worktree-relative ones. Optional; when unset,
   *  `ChatComposer` falls through to its own worktree-mention default, so
   *  every worktree call site is unaffected. */
  mentionSource?: MentionSource
  /** Passed straight to `ChatHeader`'s own `actions` slot — thread-scoped
   *  icon buttons this pane has no opinion about. The SSH rail supplies its
   *  session-history and new-session pair here; every worktree call site
   *  leaves it unset and the header renders exactly as before. */
  headerActions?: ReactNode
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
export function turnModel(model: ModelChoice | null, effort: string, contextWindow: string): TurnModelSelection | undefined {
  // Only NON-default picks go on the wire. "Default" on the picker means
  // "let the CLI decide", and the backend now applies these as start-time
  // flags by restarting the thread's session whenever they differ from the
  // ones it was launched with (`Reactor.ensureSession`) — so a default that
  // was sent explicitly would force a needless restart on every fresh
  // thread's first turn, just to pass the CLI the value it already uses.
  const options: Record<string, unknown> = {}
  if (effort !== DEFAULT_EFFORT) options.effort = effort === 'ultrathink' ? 'max' : effort
  if (contextWindow !== DEFAULT_CONTEXT_WINDOW) options.contextWindow = contextWindow
  const hasOptions = Object.keys(options).length > 0

  if (!model) return hasOptions ? { options } : undefined
  return {
    instanceId: instanceIdForAgent(model.agentId),
    model: model.modelId,
    ...(hasOptions ? { options } : {}),
  }
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
    // `@container/hero`: this hero renders at ~260px in the SSH right rail and
    // at ~900px in a full pane, and a 26px heading that reads as an invitation
    // at 900px becomes three wrapped lines with a broken underline under them
    // at 260px. Type size, spacing and the gutter all step off the pane's own
    // width rather than the viewport's — the viewport is the same in both.
    <div className="@container/hero flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-6 @sm/hero:px-5 @sm/hero:py-8">
      <div className="flex w-full max-w-3xl flex-col">
        <h2 className="mb-4 text-center text-[17px] leading-snug font-medium tracking-tight text-balance text-devdeck-fg @sm/hero:mb-6 @sm/hero:text-[26px] @sm/hero:leading-tight">
          What should we build
          {subject ? (
            <>
              {' in '}
              {/* `decoration-clone` keeps the rule under every line of a
                  wrapped connection name instead of only the first — the SSH
                  rail wraps a name like "Superapps Dev 02" far more often than
                  a full-width pane does. */}
              <span className="underline decoration-devdeck-line decoration-1 [box-decoration-break:clone] underline-offset-4 @sm/hero:underline-offset-[6px]">
                {subject}
              </span>
            </>
          ) : null}
          ?
        </h2>
        {composer}
      </div>
    </div>
  )
}

export function AgentChatPane({
  target,
  worktreeId,
  threadKey,
  machine,
  worktreeLabel,
  agentId = 'claude',
  mentionSource,
  connectEnabled = true,
  headerActions,
}: AgentChatPaneProps) {
  // Draft-thread connect gate (design spec §4, plan Task 10). `threadExists`
  // reads the same sidebar-backing query `SessionsPanel` already populates
  // (`features/data/queries.ts:1380`), so the path that matters — the
  // operator just clicked "New session" from a panel rendered off that same
  // query — costs no extra request. Fail open (pending or errored both
  // resolve `true`): a stray empty thread row is a far cheaper failure than
  // a real thread whose transcript never loads.
  //
  // The fail-open test is `isPending`, NOT `isLoading`, and the difference is
  // load-bearing for SSH threads. `useAgentThreads` is `enabled: !!machine &&
  // !!worktreeId`, and an SSH thread has no worktree — so its query is
  // permanently disabled, and react-query reports a disabled query as
  // `isPending && !isFetching`, i.e. `isLoading === false`. Gating on
  // `isLoading` therefore left `connect` false forever: the pane opened no
  // socket at all, sent no `hello`, and showed the empty hero over a thread
  // whose whole transcript was sitting in the durable log — until the operator
  // sent a message and `hasSentThisSession` forced the gate open.
  const threadsQuery = useAgentThreads(machine, worktreeId)
  // Flips permanently once this pane has sent a turn, so a `useAgentThreads`
  // cache that hasn't caught up with the row it just caused can't flap the
  // gate back to `false` mid-turn.
  const [hasSentThisSession, setHasSentThisSession] = useState(false)
  const threadExists = (threadsQuery.data ?? []).some((thread) => thread.id === threadKey)

  // Does the machine behind this pane serve agent chat at all? Only asked for
  // a runtime-targeted pane — a `'hub'` target is the SSH panel, which gates
  // itself upstream (sshChatAvailability.ts) and would answer for the wrong
  // process here.
  //
  // `agentChatSupport` only ever trusts a POSITIVE answer, so this cannot
  // block a working older runtime that reports no capability list — read that
  // module's doc comment before changing the rule.
  const targetMachine = target.kind === 'machine' ? target.machine : undefined
  const capabilities = useMachineCapabilities(targetMachine)
  const chatSupport = agentChatSupport({ machine: targetMachine, capabilities: capabilities.data })

  const connect =
    connectEnabled &&
    // Never dial a runtime that has told us it cannot serve this. The socket
    // would retry forever behind a banner promising delivery on reconnect.
    chatSupport !== 'unsupported' &&
    (hasSentThisSession || threadExists || threadsQuery.isPending || threadsQuery.isError)

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
  // Installed only: an agent this machine cannot actually run is never a
  // usable default — mirrors `ModelPicker`'s own `installed` filter on its
  // rail.
  const installedAgents = useMemo(() => (agents.data ?? []).filter((a) => a.installed), [agents.data])
  // The agent the LAST-RESORT default below falls back to: the worktree's own
  // configured agent when it is actually installed here, otherwise whatever
  // is first in the installed list — the same rule `ModelPicker`'s
  // `activeAgentId` already applies to its rail, so the fallback pill and the
  // picker's own default selection never disagree.
  const fallbackAgentId = useMemo(
    () => (installedAgents.some((a) => a.id === agentId) ? agentId : installedAgents[0]?.id),
    [installedAgents, agentId],
  )
  const fallbackModels = useAgentModels(machine, fallbackAgentId)

  // Model and effort ride the next `thread.turn.start` payload, so they are
  // local until a turn is sent. Runtime and interaction mode dispatch
  // immediately — they change how the agent behaves for the whole thread, not
  // just the next message — so the pill's displayed value is optimistic and
  // `ComposerControls` reverts it if an error frame arrives.
  //
  // ── Restored from the thread, not just remembered in the component ──
  // Held as state alone, this was correct while you sat in one pane and wrong
  // the moment you left it: every tab, pane and SSH-session switch remounts
  // this component, `model` went back to `null`, and the pill read "Model" on a
  // thread that had been running Sonnet for twenty turns — with the next
  // message silently going to the worktree's DEFAULT model instead. So an
  // explicit pick still wins, and underneath it the thread's own history
  // answers: see `lastTurnModel`.
  //
  // The pick is keyed by thread and resolved DURING RENDER rather than reset by
  // an effect, because `threadKey` changes in place here — neither call site
  // keys this component by thread — and an effect would leave the previous
  // thread's model on the pill for a frame after switching to a new one.
  //
  // This does mean a resumed model now sends an `instanceId` on turns where
  // nothing was picked, which `turnModel` above warns about — but the hazard it
  // warns about is the opposite case. Pinning the WORKTREE's configured agent
  // would yank a thread the operator had deliberately switched; pinning the
  // instance the thread's own last turn ran on re-asserts where it already is.
  const resumedModel = useMemo(() => lastTurnModel(view.items), [view.items])
  const [picked, setPicked] = useState<{ threadKey: string | undefined; choice: ModelChoice | null }>(() => ({
    threadKey,
    choice: null,
  }))
  const pickedHere = picked.threadKey === threadKey ? picked.choice : null
  // Third tier, below an explicit pick and a resumed turn: the fallback
  // agent's first catalog model (rank 0). Without this, a thread the operator
  // never touched the picker on — and that has no `turn.started` history to
  // resume, either because it is brand new or because its provider's turns
  // never carried a model (any turn sent with `model: null` stamps an empty
  // `TurnStartedPayload.Model`, so `lastTurnModel` never has anything to find)
  // — left the pill reading a bare "Model" forever, e.g. after closing and
  // reopening a Pi thread the operator had never picked a model on. A
  // concrete, visible default beats an invisible provider-decided one.
  const firstCatalogModel = fallbackModels.data?.[0]
  const defaultModel: ModelChoice | null =
    fallbackAgentId && firstCatalogModel
      ? { agentId: fallbackAgentId, modelId: firstCatalogModel.id, modelName: firstCatalogModel.name }
      : null
  const model = useMemo(
    () =>
      pickedHere ??
      (resumedModel
        ? // The raw id, not a catalog lookup: resolving the friendly name would
          // mean a second query that can lag or fail, and `modelPillLabel`
          // renders an id perfectly well. What matters is that the pill names
          // the model the conversation is actually on.
          { agentId: resumedModel.agentId, modelId: resumedModel.modelId, modelName: resumedModel.modelId }
        : defaultModel),
    [pickedHere, resumedModel, defaultModel],
  )
  const setModel = useCallback((choice: ModelChoice | null) => setPicked({ threadKey, choice }), [threadKey])

  // Effort and context window also ride the next turn, but unlike the model
  // the thread's own history cannot answer for them — nothing on the wire
  // carries them back. They live in the store, per thread and persisted
  // (`composerTurnOptions.ts`), so a remount or a reload reads back what was
  // picked instead of quietly returning to "High · 200k" while the live
  // session keeps running under something else.
  const turnOptions = useDevDeckStore((s) => s.composerTurnOptions[threadKey])
  const setComposerTurnOptions = useDevDeckStore((s) => s.setComposerTurnOptions)
  const effort = turnOptions?.effort ?? DEFAULT_EFFORT
  const contextWindow = turnOptions?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const setEffort = useCallback((value: string) => setComposerTurnOptions(threadKey, { effort: value }), [setComposerTurnOptions, threadKey])
  const setContextWindow = useCallback(
    (value: string) => setComposerTurnOptions(threadKey, { contextWindow: value }),
    [setComposerTurnOptions, threadKey],
  )

  // The two modes are THREAD state, read straight off the view. The engine
  // persists every mode change as a `thread.runtime-mode-set` /
  // `thread.interaction-mode-set` event and replays it on connect, so this
  // is the mode the agent is actually in — whoever set it, however long ago.
  // These used to be `useState` here, defaulting to approval-required /
  // default on every mount, which meant every tab or pane switch showed a
  // full-access thread as "Approval required" (and the approval card's own
  // mode buttons, which share this value, agreed with the lie). The pill's
  // optimistic pick lives inside `ComposerControls` and settles against this
  // once the engine echoes the accepted command back; a rejection leaves this
  // untouched, which is exactly what the pill reverts to.
  const runtimeMode = view.runtimeMode
  const interactionMode = view.interactionMode

  // A mode pick opens the connect gate exactly the way a send does (see
  // `hasSentThisSession`). Without this, on a brand-new worktree the gate
  // flaps: the fail-open `isPending` connect auto-creates the thread on the
  // server, then the settled (empty, not yet invalidated) threads query
  // closes the socket again — and a mode picked in that draft state sits in
  // the socket's in-memory outbox until the first message. Reload or switch
  // panes before typing and the pick is silently gone; the thread stays in
  // approval-required while the pill claimed otherwise. A mode change is a
  // deliberate act on the thread, so it connects and commits right away.
  const dispatchRuntimeMode = useCallback(
    (mode: RuntimeMode) => {
      setHasSentThisSession(true)
      setRuntimeMode(mode)
    },
    [setRuntimeMode],
  )
  const dispatchInteractionMode = useCallback(
    (mode: InteractionMode) => {
      setHasSentThisSession(true)
      setInteractionMode(mode)
    },
    [setInteractionMode],
  )

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
      setInteractionMode: dispatchInteractionMode,
      runtimeMode,
      setRuntimeMode: dispatchRuntimeMode,
      error: view.error,
    }),
    [
      model,
      setModel,
      effort,
      setEffort,
      contextWindow,
      setContextWindow,
      machine,
      agentId,
      interactionMode,
      runtimeMode,
      view.error,
      view.contextTokens,
      dispatchInteractionMode,
      dispatchRuntimeMode,
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
      chatSupport,
    }),
    [threadKey, machine.id, machine.name, agentId, status, showConnecting, view.items.length, view.error, view.status, agents, chatSupport],
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
    // Refuse rather than queue. `sendTurn` parks a frame in the socket's
    // outbox when nothing is connected, which is exactly right for a draft
    // thread (the outbox flushes the moment it connects) and exactly wrong
    // here: this runtime has told us it cannot serve chat, so nothing will
    // ever flush it. Queueing would swallow the message with no visible
    // failure — the silent-turn shape all over again, one layer up.
    if (chatSupport === 'unsupported') {
      toast.error(`${machine.name} does not support agent chat`, {
        description: 'Update the runtime to the latest version, then try again.',
      })
      return
    }
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
      dispatchInteractionMode(submission.mode)
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
      mentionSource={mentionSource}
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
        // as "no primary id to strip" rather than a false badge. `''` also
        // tells ChatHeader to show `subjectLabel` in the badge's place
        // instead (Task 12) — see that prop's own doc comment.
        worktreeId={worktreeId ?? ''}
        threadKey={threadKey}
        socketStatus={status}
        threadStatus={view.status}
        subjectLabel={worktreeId ? undefined : worktreeLabel}
        actions={headerActions}
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
