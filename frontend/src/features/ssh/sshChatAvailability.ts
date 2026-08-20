/**
 * Decides whether a saved SSH connection's DevOps chat can run, and on which
 * machine — see `SSHAgentChatPanel.tsx`'s doc comment for why the answer is
 * "the connection's executor runtime" rather than "the hub".
 *
 * Pure and React-free so the decision can be tested directly. The panel owns
 * only the rendering of whatever this returns.
 */
import type { Machine, SSHConnection } from '@/store/types'

/** Must match `handler.CapSSHChat` on the backend. */
export const SSH_CHAT_CAPABILITY = 'ssh-chat'

export type SSHChatAvailability =
  /** Still resolving the machine registry or the runtime's capabilities.
   *  Distinct from every failure below: a panel must not accuse a machine of
   *  being out of date while the answer is still in flight. */
  | { kind: 'loading' }
  /** The connection has no `executorMachineId`, so there is no machine to run
   *  the agent on. Fixed in the connection's own settings. */
  | { kind: 'no-executor' }
  /** `executorMachineId` names a machine the hub's registry does not have —
   *  it was deleted, or this client's registry is stale. */
  | { kind: 'unknown-machine'; machineId: string }
  /** The machine is registered but could not be asked (offline, or its URL no
   *  longer resolves). Deliberately NOT reported as "out of date": telling an
   *  operator to update a machine that is merely unreachable sends them to fix
   *  the wrong thing. */
  | { kind: 'unreachable'; machine: Machine }
  /** The machine answered and does not serve SSH chat — either it reported no
   *  capability list at all (a build predating capability reporting) or a list
   *  without `ssh-chat`. Both mean the same thing to the operator: update it. */
  | { kind: 'outdated'; machine: Machine }
  /** Good to go — open the socket against this machine's runtime. */
  | { kind: 'ready'; machine: Machine }

export interface SSHChatAvailabilityInput {
  connection: SSHConnection | undefined
  /** The hub's machine registry, or undefined while it loads. */
  machines: Machine[] | undefined
  /** `useMachineCapabilities` result for the resolved executor:
   *  - `undefined` — not resolved yet
   *  - `null` — the machine answered but reported no capability array
   *  - `string[]` — what it reported */
  capabilities: string[] | null | undefined
  /** True once the capabilities query has settled into an error (unreachable). */
  capabilitiesFailed?: boolean
}

/**
 * Resolves the connection + registry + capability probe into one decision.
 *
 * Order matters and is not arbitrary: each check below is only meaningful once
 * the one before it has passed, and reporting a later failure while an earlier
 * one is unresolved is how a panel ends up telling the operator to update a
 * machine it has not even located yet.
 */
export function sshChatAvailability({
  connection,
  machines,
  capabilities,
  capabilitiesFailed = false,
}: SSHChatAvailabilityInput): SSHChatAvailability {
  // The connection itself has to load before its executor can be read. Without
  // this, the first render of every panel claims "no executor assigned".
  if (!connection) return { kind: 'loading' }

  const machineId = connection.executorMachineId
  if (!machineId) return { kind: 'no-executor' }

  if (!machines) return { kind: 'loading' }
  const machine = machines.find((m) => m.id === machineId)
  if (!machine) return { kind: 'unknown-machine', machineId }

  // Unreachable is checked before the capability verdict because a failed
  // probe leaves `capabilities` undefined, which is otherwise indistinguishable
  // from "still loading".
  if (capabilitiesFailed) return { kind: 'unreachable', machine }
  if (capabilities === undefined) return { kind: 'loading' }

  // `null` (no array reported) and a list without the capability are the same
  // answer to the operator — see the 'outdated' variant's comment.
  if (capabilities === null || !capabilities.includes(SSH_CHAT_CAPABILITY)) {
    return { kind: 'outdated', machine }
  }
  return { kind: 'ready', machine }
}

/** The sentence shown in the panel's disabled state, and the reason it names
 *  a fix rather than just a fault. Returns null when chat can run. */
export function sshChatUnavailableMessage(a: SSHChatAvailability, connectionName?: string): string | null {
  const named = connectionName ? `“${connectionName}”` : 'this connection'
  switch (a.kind) {
    case 'no-executor':
      return `DevOps chat runs on the runtime machine that reaches this host, and ${named} is not assigned to one yet. Pick an executor machine in the connection's settings to enable it.`
    case 'unknown-machine':
      return `${named} is assigned to a runtime machine that is no longer registered (${a.machineId}). Re-assign it to an existing machine to use DevOps chat.`
    case 'unreachable':
      return `Could not reach ${a.machine.name}. DevOps chat runs on that machine, so it needs to be online — check that the runtime is running, then reopen this panel.`
    case 'outdated':
      return `${a.machine.name} is running a DevDeck runtime that does not support DevOps chat yet. Update it to the latest version to enable it.`
    default:
      return null
  }
}
