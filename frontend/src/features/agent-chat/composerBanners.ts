/**
 * Pure decision layer for the composer banner stack (spec F, Design §4). No
 * DOM, no React, no lucide import — this module decides *which* banners
 * exist and in what order; `AgentChatPane` is the only place that turns a
 * decision into a `ReactNode` icon or an `onDismiss` closure.
 *
 * Priority order, fixed regardless of which conditions are true:
 * connection/error → agent-missing → session-stopped (spec "Data flow").
 */
import type { AgentSummary } from '@/store/types'
import type { AgentChatSupport } from '@/features/agent-chat/agentChatSupport'
import type { AgentSocketStatus } from '@/features/agent-chat/useAgentChatSocket'

export type ComposerBannerTone = 'default' | 'warning' | 'error' | 'info'
export type ComposerBannerIconKey =
  | 'connection'
  | 'transport-error'
  | 'agent-missing'
  | 'session-stopped'
  /** F0 — the runtime cannot serve this pane (too old, or never answered). */
  | 'runtime-unsupported'

export interface ComposerBannerSpec {
  /** `'connection:<threadKey>' | 'thread-error:<threadKey>' |
   *  'agent-missing:<machineId>:<agentId>' | 'session-stopped:<threadKey>'` */
  id: string
  tone: ComposerBannerTone
  iconKey: ComposerBannerIconKey
  title: string
  description?: string
  /** `false` for F1 only — its condition clears itself, so an X would just
   *  come back and teach the user the button is broken (spec Design §4). */
  dismissible: boolean
}

export interface ComposerBannersInput {
  threadKey: string
  machineId: string
  machineName: string
  agentId: string
  /** `useAgentChatSocket`'s status. */
  socketStatus: AgentSocketStatus
  /** `AgentChatPane`'s existing dedupe flag — the blocking "Connecting…"
   *  message that already covers first-connect. */
  showConnecting: boolean
  /** `view.items.length > 0` — picks F1's copy (fresh connect vs reconnect). */
  hasTranscript: boolean
  /** `view.error` — TRANSPORT ONLY. See the spec's Correction: this is
   *  `transportError`, not a thread-domain error. */
  threadError: string | null
  threadStatus: 'idle' | 'running' | 'waiting' | 'stopped'
  /** Shape of `useAgents()`'s result. */
  agents: { data: AgentSummary[] | undefined; isLoading: boolean; error: unknown }
  dismissed: ReadonlySet<string>
  /** `agentChatSupport()`'s verdict for this pane's machine. Only
   *  `'unsupported'` — a runtime that positively answered without the
   *  capability — changes anything here. Defaults to `'unknown'` so every
   *  existing caller and test keeps today's behaviour. */
  chatSupport?: AgentChatSupport
}

/** Computes the ordered candidate list with no dismissal filter applied —
 *  shared by `composerBanners` and `activeBannerIds` so the two can never
 *  disagree about what "active" means. */
function candidates(input: Omit<ComposerBannersInput, 'dismissed'>): ComposerBannerSpec[] {
  const { threadKey, machineId, machineName, agentId, socketStatus, showConnecting, hasTranscript, threadError, threadStatus, agents } =
    input
  const chatSupport = input.chatSupport ?? 'unknown'

  const result: ComposerBannerSpec[] = []

  // ── F0: this runtime cannot serve the pane ──
  //
  // Ahead of F1 and mutually exclusive with it, because F1's copy ("the agent
  // keeps working while you are disconnected — a message sent now is queued
  // and delivered on reconnect") is a promise, and here nothing is going to
  // deliver on it. A pane pointed at a runtime that cannot answer sat on
  // "Connecting…" indefinitely, reassuring the operator while queueing
  // messages nothing would ever send.
  //
  // Two ways to get here, and they are worth telling apart because the fix
  // differs:
  //
  //  - `chatSupport === 'unsupported'` — the runtime ANSWERED and said it does
  //    not serve agent chat. Conclusive; the socket is not even opened (see
  //    AgentChatPane's connectEnabled), so this is the only thing to say.
  //  - `socketStatus === 'unreachable'` — the socket has never once opened
  //    after several attempts. Could be an offline machine or a build too old
  //    to serve the route, and the client genuinely cannot tell which, so the
  //    copy names both rather than guessing.
  //
  // Not dismissible: the composer below it cannot send, so hiding the reason
  // would leave an input that silently does nothing.
  if (chatSupport === 'unsupported') {
    result.push({
      id: `runtime-unsupported:${machineId}`,
      tone: 'error',
      iconKey: 'runtime-unsupported',
      title: `${machineName} does not support agent chat`,
      description: `This runtime is running a DevDeck version without the agent chat service. Update ${machineName} to the latest version to use chat here.`,
      dismissible: false,
    })
    return result
  }
  if (socketStatus === 'unreachable') {
    result.push({
      id: `runtime-unreachable:${machineId}:${threadKey}`,
      tone: 'error',
      iconKey: 'runtime-unsupported',
      title: `Could not connect to ${machineName}`,
      description: `The agent chat connection never opened. Check that the runtime is online, and update ${machineName} to the latest version if it is — an older runtime may not serve agent chat at all.`,
      dismissible: false,
    })
    return result
  }

  // F1 (connection) and F2 (transport error) are mutually exclusive by fold:
  // F2 only fires once the socket is open, so a closed socket always shows
  // F1 instead, never both (spec Design §4, "F1 and F2 are mutually
  // exclusive, by fold"). A `'draft'` socket (spec E, `2026-08-15-composer-
  // drafts-and-stash-design.md` §4) has never attempted a connection — no
  // socket is open, no hello was sent — so it is excluded here the same way
  // ChatHeader's dot treats it: nothing is pending, nothing to report.
  if (socketStatus !== 'open' && socketStatus !== 'draft' && !showConnecting) {
    result.push({
      id: `connection:${threadKey}`,
      tone: 'warning',
      iconKey: 'connection',
      title: hasTranscript ? `Reconnecting to ${machineName}` : 'Connecting…',
      description: 'The agent keeps working while you are disconnected — a message sent now is queued and delivered on reconnect.',
      dismissible: false,
    })
  } else if (socketStatus === 'open' && threadError !== null) {
    result.push({
      id: `thread-error:${threadKey}`,
      tone: 'error',
      iconKey: 'transport-error',
      title: 'The agent chat connection reported an error',
      description: threadError,
      dismissible: true,
    })
  }

  // F3 (agent not installed): all three guards must pass before
  // `installed === false` is trusted (spec Design §4, "F3 — agent not
  // installed").
  if (!agents.isLoading && !agents.error && agents.data) {
    const entry = agents.data.find((a) => a.id === agentId)
    if (entry && !entry.installed) {
      result.push({
        id: `agent-missing:${machineId}:${agentId}`,
        tone: 'warning',
        iconKey: 'agent-missing',
        title: `${entry.name} is not installed on ${machineName}`,
        description: 'Install it, or pick a different agent from the model picker below.',
        dismissible: true,
      })
    }
  }

  // F4 (session stopped) is always last — informational, must never cover
  // anything (spec Design §4, "F4 — session stopped").
  if (threadStatus === 'stopped') {
    result.push({
      id: `session-stopped:${threadKey}`,
      tone: 'info',
      iconKey: 'session-stopped',
      title: 'Session stopped',
      description: 'Sending a message starts a new session.',
      dismissible: true,
    })
  }

  return result
}

export function composerBanners(input: ComposerBannersInput): ComposerBannerSpec[] {
  return candidates(input).filter((spec) => !input.dismissed.has(spec.id))
}

/** The raw candidate id set with NO dismissal filter applied — i.e. "what
 *  WOULD show right now, ignoring the dismissed set". `AgentChatPane` uses
 *  this to prune its local `dismissed` state: any id no longer in this set
 *  is dropped, so a later recurrence of the same condition (same stable id)
 *  shows again instead of staying hidden forever. Same self-healing shape as
 *  `ComposerBannerStack`'s own `exitingItemId ∩ items` (spec Design §1, "The
 *  exiting id self-heals") — a different layer, same idea. */
export function activeBannerIds(input: Omit<ComposerBannersInput, 'dismissed'>): Set<string> {
  return new Set(candidates(input).map((spec) => spec.id))
}
