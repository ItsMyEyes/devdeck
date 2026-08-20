/**
 * Whether a runtime machine can serve the worktree agent chat at all.
 *
 * Deliberately NOT the same rule as `sshChatAvailability.ts`, and the
 * difference is the whole point of this file:
 *
 *  - SSH chat is new. A runtime that reports no capability list at all cannot
 *    have it, so "no list" is conclusively "outdated".
 *  - Worktree chat is old. It long predates capability reporting, so a runtime
 *    that reports no list is overwhelmingly likely to be an older build that
 *    serves chat perfectly well. Treating "no list" as "unsupported" there
 *    would tell operators to update machines that are working fine — every
 *    runtime not yet on the build that introduced `capabilities`.
 *
 * So this only ever trusts a POSITIVE statement. A capability list that is
 * present and does not name `agent-chat` is a definite no; anything else is
 * `'unknown'`, which means "connect and find out". When `'unknown'` turns out
 * to be wrong, the socket's own `'unreachable'` state (see
 * `useAgentChatSocket.ts`) is what stops the pane lying about it.
 */
import type { Machine } from '@/store/types'

/** Must match `handler.CapAgentChat` on the backend. */
export const AGENT_CHAT_CAPABILITY = 'agent-chat'

export type AgentChatSupport =
  /** The machine positively advertises the capability. */
  | 'supported'
  /** The machine answered with a capability list that does not include it.
   *  The only case that blocks the socket. */
  | 'unsupported'
  /** No answer yet, no list reported, or nothing to ask (a hub-targeted pane).
   *  Connect and find out. */
  | 'unknown'

export interface AgentChatSupportInput {
  /** The runtime this pane targets, or undefined for a hub-targeted pane
   *  (the SSH panel, which does its own gating upstream). */
  machine: Machine | undefined
  /** `useMachineCapabilities` result: `undefined` while loading or failed,
   *  `null` when the machine reported no capability array, `string[]` when it
   *  did. */
  capabilities: string[] | null | undefined
}

export function agentChatSupport({ machine, capabilities }: AgentChatSupportInput): AgentChatSupport {
  if (!machine) return 'unknown'
  // `null` is "reported no list" — an old build. Explicitly NOT unsupported;
  // see this file's doc comment.
  if (capabilities === undefined || capabilities === null) return 'unknown'
  return capabilities.includes(AGENT_CHAT_CAPABILITY) ? 'supported' : 'unsupported'
}
