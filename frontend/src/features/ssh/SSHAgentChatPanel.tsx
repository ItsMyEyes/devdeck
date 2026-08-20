/**
 * The SSH right rail's third panel (plan Task 12, design spec §7): the
 * existing `AgentChatPane`, pointed at this connection's SSH thread.
 *
 * ## Where this chat runs
 *
 * On the connection's **executor runtime**, not on the hub. The agent process,
 * the `devdeck-ssh` tool calls it makes, and the SSH dial itself all happen on
 * the machine that actually reaches the host; the hub only decrypts the
 * credential on that runtime's behalf (`handler.RuntimeSSHHandler`).
 *
 * This panel used to hardcode `target={{ kind: 'hub' }}`, which meant an
 * operator who assigned a connection to a runtime still got an agent spawned on
 * the hub — the wrong machine, often one with no route to the host and no CLI
 * agent installed, and with no indication that was happening.
 *
 * Three states, and the panel must be able to tell them apart:
 *
 *  1. **No executor assigned.** DevOps chat has no machine to run on. The
 *     operator fixes this in the connection's own settings, so say that.
 *  2. **Executor assigned, runtime too old.** The machine answers `/api/whoami`
 *     but does not advertise `ssh-chat` (`handler.CapSSHChat`). Opening a
 *     socket anyway produced a thread whose every turn failed — which reads as
 *     a broken feature rather than an out-of-date machine. Tell them to update.
 *  3. **Executor assigned and capable.** Dial that machine's runtime, exactly
 *     as a worktree thread does.
 *
 * `threadKey` defaults to `orchestration.SSHThreadID(connectionId)` —
 * `` `ssh:${connectionId}` `` — the backend's thread-namespace contract
 * (design spec §3.1), not a display string. A caller may pass one of that
 * connection's OTHER sessions instead (`ssh:<id>::chat-N`), which is the same
 * key space worktree chats use; anything outside it addresses a thread the
 * engine never seeded a workspace or minted a token for.
 *
 * `HUB_MACHINE` survives as the placeholder for the hub-scoped queries this
 * panel still makes — the session list lives in the hub's registry, not on the
 * runtime. Its empty `url` resolves `machineRequest`'s direct-mode probe to a
 * same-origin `/api/...` request, landing on this process's own routes. Same
 * "no real machine" shape `ChatComposer.tsx` and `MessagesTimeline.tsx` use.
 */
import { useEffect, useMemo, useState } from 'react'
import { History, Plus, ServerCog } from 'lucide-react'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { AgentChatPane } from '@/features/agent-chat/AgentChatPane'
import { chatHeaderActionClassName } from '@/features/agent-chat/ChatHeader'
import { sshMentionSource } from '@/features/agent-chat/composerMention'
import { nextFreeThreadKey, SessionsPanel } from '@/features/agent-chat/SessionsPanel'
import { useAgentThreads, useMachineCapabilities, useMachines, useSSHConnections } from '@/features/data/queries'
import { sshChatAvailability, sshChatUnavailableMessage } from '@/features/ssh/sshChatAvailability'
import type { Machine } from '@/store/types'

/** `name` is not cosmetic: the composer's connection and missing-agent
 *  banners interpolate it ("Reconnecting to …", "Claude Code is not installed
 *  on …" — see `composerBanners.ts`), and an empty string leaves those
 *  sentences hanging mid-clause on the exact surface design spec §3.2 relies
 *  on to explain a hub with no CLI agent installed. */
export const HUB_MACHINE: Machine = { id: '', name: 'this hub', url: '', key: '', isLocal: false, signingPublicKey: '' }

export function SSHAgentChatPanel({
  connectionId,
  visible,
  threadKey,
  onSelectThread,
}: {
  connectionId: string
  visible: boolean
  /** Which of this connection's sessions to show. Defaults to the primary
   *  thread, `ssh:<connectionId>` — extras carry a `::chat-N` suffix on top of
   *  it, the same key space worktree chats use. The backend already understood
   *  this: `SSHConnectionIDForThread` strips the suffix, and the store derives
   *  `worktree_id` by cutting at `::`, so every session of a connection is
   *  already listed together. Only this panel was hardcoded to one. */
  threadKey?: string
  /** Switches which session this panel shows. Supplied by whoever owns
   *  `threadKey` (`SSHRightSidebar`), and its presence is what puts the
   *  history/new-session pair in the chat header — without a setter those two
   *  buttons would have nothing to do, so a caller that pins one thread gets
   *  no dead chrome. */
  onSelectThread?: (threadKey: string) => void
}) {
  // Resolved purely for display (ChatHeader's subject label — see
  // AgentChatPane.tsx's `subjectLabel` wiring) — the connection's own name is
  // the honest thing to show for a thread with no worktree at all. Unlike
  // StatsPane/SSHForwardsPanel's own `visible`-gated polling queries, this
  // list is already cached (`staleTime: 10_000`) by every other SSH surface
  // that reads it, so there is no separate poll here to pause; `visible` is
  // recorded on this panel's own root instead, purely so a hidden chat panel
  // is inspectable the same way its sibling panels are.
  const connectionsQuery = useSSHConnections()
  const connections = connectionsQuery.data ?? []
  const connection = connections.find((c) => c.id === connectionId)

  // ── Which machine runs this chat ──
  //
  // The executor runtime, or nothing at all. Both queries are gated on the
  // step before them so a panel for an unassigned connection never probes a
  // machine, and a panel whose registry has not loaded never concludes the
  // machine is missing.
  const machinesQuery = useMachines()
  const executorMachine = connection?.executorMachineId
    ? machinesQuery.data?.find((m) => m.id === connection.executorMachineId)
    : undefined
  const capabilitiesQuery = useMachineCapabilities(executorMachine)

  const availability = sshChatAvailability({
    connection: connectionsQuery.isPending ? undefined : connection,
    machines: machinesQuery.data,
    capabilities: capabilitiesQuery.data,
    capabilitiesFailed: capabilitiesQuery.isError,
  })
  const unavailable = sshChatUnavailableMessage(availability, connection?.name)

  // Memoised because it is a `useEditor` dependency two levels down
  // (`ComposerPromptEditor`), and @tiptap/react compares those by identity: a
  // fresh object per render tears the editor down and rebuilds it from the
  // value captured at mount, silently erasing whatever the operator had
  // typed. This panel re-renders on the connections query settling, on every
  // rail panel switch, and on every frame of a rail resize drag.
  const mentionSource = useMemo(() => sshMentionSource(connectionId), [connectionId])

  // One-way latch: this panel is mounted for every SSH tab (the rail hides it
  // rather than unmounting it, so a toggle keeps the socket and the
  // transcript), and without the latch that would mean every tab opened an
  // agent socket and had the server auto-create a thread nobody asked for.
  // Once opened it stays true, so hiding the panel again does not drop the
  // socket — which is the whole point of hide-not-unmount.
  const [everOpened, setEverOpened] = useState(visible)
  useEffect(() => {
    if (visible) setEverOpened(true)
  }, [visible])

  // ── Session history + new session (chat header) ──
  //
  // Every session of this connection already shares one `worktree_id` on the
  // backend (the store cuts a thread key at `::`), so the same
  // `useAgentThreads` the rail's own Sessions panel reads lists them here too
  // — same query key, so react-query serves both from one request and one
  // poll rather than two.
  const sessionsWorktreeId = `ssh:${connectionId}`
  const activeThreadKey = threadKey ?? sessionsWorktreeId
  const sessions = useAgentThreads(HUB_MACHINE, sessionsWorktreeId)
  const [historyOpen, setHistoryOpen] = useState(false)

  // "New session" writes nothing: a thread is created by its WebSocket's
  // hello (`AgentWSHandler.autoCreateThread`), so this only has to name a key
  // nobody is using and point the panel at it — see `SessionsPanel`'s own doc
  // comment. An abandoned one therefore costs a key and nothing else.
  function handleNewSession() {
    onSelectThread?.(nextFreeThreadKey(sessionsWorktreeId, (sessions.data ?? []).map((thread) => thread.id)))
  }

  // A popover rather than a jump to the rail's Sessions panel, which is the
  // other place this list lives: switching panels replaces the chat with the
  // list, and picking a session from a header button should leave the
  // conversation you were reading on screen behind it. `SessionsPanel` is
  // mounted whole — it already owns loading/error/empty, search, delete and
  // its own "new" affordance, so none of that is reimplemented at this size.
  const headerActions = onSelectThread ? (
    <>
      <TabStripPopoverMenu
        trigger={<History size={13} aria-hidden="true" />}
        triggerClassName={chatHeaderActionClassName}
        triggerTitle="Session history"
        triggerAriaLabel="Session history"
        align="end"
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      >
        <div className="flex h-[min(60vh,320px)] w-[248px] flex-col">
          <SessionsPanel
            worktreeId={sessionsWorktreeId}
            machine={HUB_MACHINE}
            activeThreadKey={activeThreadKey}
            onSelectThread={(next) => {
              onSelectThread(next)
              setHistoryOpen(false)
            }}
          />
        </div>
      </TabStripPopoverMenu>
      <button
        type="button"
        title="New session"
        aria-label="New session"
        onClick={handleNewSession}
        className={chatHeaderActionClassName}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </>
  ) : undefined

  // Disabled state rather than a chat pane. Rendering the pane with a
  // placeholder machine would be worse than useless: `connectEnabled` gates the
  // socket, but the composer would still invite the operator to type a message
  // that could never be sent, and the server would auto-create a thread for a
  // connection that has nowhere to run it.
  if (unavailable) {
    return (
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        data-visible={String(visible)}
        data-chat-unavailable={availability.kind}
      >
        <ServerCog size={22} className="text-[var(--text-3)]" aria-hidden="true" />
        <p className="max-w-[42ch] text-[12px] leading-relaxed text-[var(--text-2)]">{unavailable}</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-visible={String(visible)}>
      <AgentChatPane
        // The executor runtime, never the hub — see this file's doc comment.
        // Past the guard above only 'ready' and 'loading' remain; the HUB_MACHINE
        // fallback covers 'loading' and is inert, because connectEnabled below
        // refuses to dial anything until the machine is actually resolved.
        target={availability.kind === 'ready' ? { kind: 'machine', machine: availability.machine } : { kind: 'hub' }}
        threadKey={activeThreadKey}
        machine={availability.kind === 'ready' ? availability.machine : HUB_MACHINE}
        worktreeLabel={connection?.name}
        mentionSource={mentionSource}
        // Never open a socket before the executor is known. Without the
        // `ready` half, the first frames of every panel would dial the hub —
        // creating a thread on the wrong process, which is the exact bug this
        // gate exists to remove.
        connectEnabled={everOpened && availability.kind === 'ready'}
        headerActions={headerActions}
      />
    </div>
  )
}
