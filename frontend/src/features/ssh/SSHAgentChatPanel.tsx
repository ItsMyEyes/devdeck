/**
 * The SSH right rail's third panel (plan Task 12, design spec §7): the
 * existing `AgentChatPane`, pointed at this connection's SSH thread and
 * routed hub-direct instead of through a runtime `Machine` — see
 * `useAgentChatSocket.ts`'s `AgentChatTarget` doc comment for why an SSH
 * thread has no machine to dial through `machineWsUrl`.
 *
 * `threadKey` is exactly `orchestration.SSHThreadID(connectionId)` —
 * `` `ssh:${connectionId}` `` — the backend's thread-namespace contract
 * (design spec §3.1), not a display string. Anything else here addresses a
 * thread the engine never seeded a workspace or minted a token for.
 *
 * `AgentChatPane` still requires a `Machine` prop: its attachment downloads,
 * agent/skill catalog, and thread-listing queries all go through
 * `machineRequest`, which needs *some* `Machine` to resolve a base URL from.
 * An SSH thread has no runtime machine — its CLI agent runs on the hub
 * itself (design spec §3.2: "the hub host must have a CLI agent
 * installed") — so `HUB_MACHINE` below, with an empty `url`, resolves
 * `machineRequest`'s direct-mode probe to a same-origin `/api/...` request,
 * landing on exactly that process's own routes (`GET /api/agents` etc. are
 * registered on every process's mux, not behind a machine id). Same "no real
 * machine" placeholder shape `ChatComposer.tsx` and `MessagesTimeline.tsx`
 * already use, for the same reason.
 */
import { AgentChatPane } from '@/features/agent-chat/AgentChatPane'
import { sshMentionSource } from '@/features/agent-chat/composerMention'
import { useSSHConnections } from '@/features/data/queries'
import type { Machine } from '@/store/types'

const HUB_MACHINE: Machine = { id: '', name: '', url: '', key: '', isLocal: false, signingPublicKey: '' }

export function SSHAgentChatPanel({ connectionId, visible }: { connectionId: string; visible: boolean }) {
  // Resolved purely for display (ChatHeader's subject label — see
  // AgentChatPane.tsx's `subjectLabel` wiring) — the connection's own name is
  // the honest thing to show for a thread with no worktree at all. Unlike
  // StatsPane/SSHForwardsPanel's own `visible`-gated polling queries, this
  // list is already cached (`staleTime: 10_000`) by every other SSH surface
  // that reads it, so there is no separate poll here to pause; `visible` is
  // recorded on this panel's own root instead, purely so a hidden chat panel
  // is inspectable the same way its sibling panels are.
  const connections = useSSHConnections().data ?? []
  const connection = connections.find((c) => c.id === connectionId)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-visible={String(visible)}>
      <AgentChatPane
        target={{ kind: 'hub' }}
        threadKey={`ssh:${connectionId}`}
        machine={HUB_MACHINE}
        worktreeLabel={connection?.name}
        mentionSource={sshMentionSource(connectionId)}
      />
    </div>
  )
}
