import { describe, expect, it } from 'vitest'
import { activeBannerIds, composerBanners } from '@/features/agent-chat/composerBanners'
import type { ComposerBannersInput } from '@/features/agent-chat/composerBanners'
import type { AgentSummary } from '@/store/types'

function agentSummary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'claude',
    name: 'Claude',
    description: '',
    icon: '',
    installed: true,
    modelCount: 1,
    skillCount: 0,
    ...overrides,
  }
}

/** Every field set to the "nothing is wrong" value, so each test only
 *  overrides the one axis it means to exercise. */
function nominalInput(overrides: Partial<ComposerBannersInput> = {}): ComposerBannersInput {
  return {
    threadKey: 'thread-1',
    machineId: 'machine-1',
    machineName: 'workhorse',
    agentId: 'claude',
    socketStatus: 'open',
    showConnecting: false,
    hasTranscript: true,
    threadError: null,
    threadStatus: 'idle',
    agents: { data: [agentSummary()], isLoading: false, error: undefined },
    dismissed: new Set<string>(),
    ...overrides,
  }
}

describe('composerBanners', () => {
  it('returns no banners when everything is nominal', () => {
    const result = composerBanners(nominalInput())
    expect(result).toEqual([])
  })

  it('returns only the connection banner when the socket is closed', () => {
    const result = composerBanners(nominalInput({ socketStatus: 'closed' }))
    expect(result).toHaveLength(1)
    expect(result[0].id.startsWith('connection:')).toBe(true)
    expect(result[0].dismissible).toBe(false)
  })

  it('folds the error banner into the connection banner while the socket is closed', () => {
    const result = composerBanners(nominalInput({ socketStatus: 'closed', threadError: 'boom' }))
    expect(result).toHaveLength(1)
    expect(result[0].id.startsWith('connection:')).toBe(true)
  })

  it('shows the error banner when the socket is open and a transport error is set', () => {
    const result = composerBanners(nominalInput({ socketStatus: 'open', threadError: 'boom' }))
    expect(result).toHaveLength(1)
    expect(result[0].id.startsWith('thread-error:')).toBe(true)
    expect(result[0].tone).toBe('error')
    expect(result[0].dismissible).toBe(true)
  })

  it('suppresses the connection banner while the blocking connecting message is on screen', () => {
    const result = composerBanners(nominalInput({ socketStatus: 'closed', showConnecting: true }))
    expect(result).toEqual([])
  })

  it('titles the connection banner as a fresh connect when there is no transcript yet', () => {
    const result = composerBanners(nominalInput({ socketStatus: 'closed', hasTranscript: false }))
    expect(result[0].title.toLowerCase()).toContain('connecting')
  })

  it('titles the connection banner with the machine name once a transcript exists', () => {
    const result = composerBanners(nominalInput({ socketStatus: 'closed', hasTranscript: true, machineName: 'workhorse' }))
    expect(result[0].title).toContain('workhorse')
  })

  it('does not show the agent-missing banner while the agents query is loading', () => {
    const result = composerBanners(
      nominalInput({ agents: { data: undefined, isLoading: true, error: undefined } }),
    )
    expect(result).toEqual([])
  })

  it('does not show the agent-missing banner when the agents query errored', () => {
    const result = composerBanners(
      nominalInput({ agents: { data: undefined, isLoading: false, error: new Error('nope') } }),
    )
    expect(result).toEqual([])
  })

  it('does not show the agent-missing banner when the agent id is absent from the catalog', () => {
    const result = composerBanners(
      nominalInput({ agentId: 'ghost', agents: { data: [agentSummary({ id: 'claude' })], isLoading: false, error: undefined } }),
    )
    expect(result).toEqual([])
  })

  it('shows the agent-missing banner once the query is settled and the agent is not installed', () => {
    const result = composerBanners(
      nominalInput({ agents: { data: [agentSummary({ installed: false })], isLoading: false, error: undefined } }),
    )
    expect(result).toHaveLength(1)
    expect(result[0].id.startsWith('agent-missing:')).toBe(true)
    expect(result[0].tone).toBe('warning')
  })

  it('shows the session-stopped banner last', () => {
    const result = composerBanners(nominalInput({ threadStatus: 'stopped' }))
    expect(result).toHaveLength(1)
    expect(result[0].id.startsWith('session-stopped:')).toBe(true)
    expect(result[0].tone).toBe('info')
  })

  it('orders connection/error, then agent-missing, then session-stopped when all three coexist', () => {
    const result = composerBanners(
      nominalInput({
        socketStatus: 'closed',
        threadStatus: 'stopped',
        agents: { data: [agentSummary({ installed: false })], isLoading: false, error: undefined },
      }),
    )
    expect(result).toHaveLength(3)
    expect(result[0].id.startsWith('connection:')).toBe(true)
    expect(result[1].id.startsWith('agent-missing:')).toBe(true)
    expect(result[2].id.startsWith('session-stopped:')).toBe(true)
  })

  it('prunes a dismissed id via activeBannerIds once its condition goes false, and lets it reappear', () => {
    const stoppedInput = nominalInput({ threadStatus: 'stopped' })
    const stoppedId = 'session-stopped:thread-1'

    // Dismissed while the condition still holds: stays out.
    const dismissed = new Set<string>([stoppedId])
    const withDismissal = composerBanners({ ...stoppedInput, dismissed })
    expect(withDismissal.find((b) => b.id === stoppedId)).toBeUndefined()

    // Condition goes false: activeBannerIds no longer contains the id, so a
    // caller-side `dismissed ∩ activeBannerIds(...)` prune would drop it.
    const runningInput = nominalInput({ threadStatus: 'running' })
    const activeWhileRunning = activeBannerIds(runningInput)
    expect(activeWhileRunning.has(stoppedId)).toBe(false)

    // Prune performed by the caller, then the condition returns: the banner
    // reappears because the id is no longer in the dismissed set.
    const prunedDismissed = new Set([...dismissed].filter((id) => activeWhileRunning.has(id)))
    const reappeared = composerBanners({ ...stoppedInput, dismissed: prunedDismissed })
    expect(reappeared.find((b) => b.id === stoppedId)).toBeDefined()
  })
})

// ── F0: the runtime cannot serve this pane ──
//
// The reported bug: a chat pane pointed at a runtime that never answered sat
// on "Connecting…" indefinitely, under copy promising that "the agent keeps
// working while you are disconnected — a message sent now is queued and
// delivered on reconnect". Nothing was going to deliver on that.
describe('composerBanners — runtime cannot serve the pane', () => {
  it('replaces the reassuring connection banner when the runtime says it does not support chat', () => {
    const result = composerBanners(nominalInput({ chatSupport: 'unsupported', socketStatus: 'draft' }))
    expect(result).toHaveLength(1)
    expect(result[0].iconKey).toBe('runtime-unsupported')
    expect(result[0].tone).toBe('error')
    expect(result[0].title).toContain('workhorse')
    expect(result[0].description).toContain('Update')
  })

  it('tells the operator to update when the socket never opened', () => {
    const result = composerBanners(nominalInput({ socketStatus: 'unreachable' }))
    expect(result).toHaveLength(1)
    expect(result[0].iconKey).toBe('runtime-unsupported')
    // Both causes are named, because the client genuinely cannot tell an
    // offline machine from a build too old to serve the route.
    expect(result[0].description).toContain('online')
    expect(result[0].description).toContain('update')
  })

  // The promise in F1's copy is the thing that made this a bug, so F0 must
  // never appear alongside it.
  it('never shows the "queued and delivered on reconnect" promise alongside F0', () => {
    for (const input of [
      nominalInput({ chatSupport: 'unsupported', socketStatus: 'closed' }),
      nominalInput({ socketStatus: 'unreachable' }),
    ]) {
      for (const spec of composerBanners(input)) {
        expect(spec.description ?? '').not.toContain('delivered on reconnect')
      }
    }
  })

  // It also cannot be dismissed away: the composer under it cannot send, so
  // hiding the reason would leave an input that silently does nothing.
  it('is not dismissible', () => {
    expect(composerBanners(nominalInput({ chatSupport: 'unsupported' }))[0].dismissible).toBe(false)
    expect(composerBanners(nominalInput({ socketStatus: 'unreachable' }))[0].dismissible).toBe(false)
  })

  it('suppresses the lower-priority banners, which are noise when chat cannot run at all', () => {
    const result = composerBanners(
      nominalInput({
        chatSupport: 'unsupported',
        threadStatus: 'stopped',
        agents: { data: [agentSummary({ installed: false })], isLoading: false, error: undefined },
      }),
    )
    expect(result).toHaveLength(1)
    expect(result[0].iconKey).toBe('runtime-unsupported')
  })

  // 'unknown' is the state every older-but-working runtime reports (see
  // agentChatSupport.ts). It must change nothing at all.
  it('leaves behaviour untouched when support is unknown', () => {
    expect(composerBanners(nominalInput({ chatSupport: 'unknown' }))).toEqual([])
    expect(composerBanners(nominalInput())).toEqual([])
    const connecting = composerBanners(nominalInput({ chatSupport: 'unknown', socketStatus: 'closed' }))
    expect(connecting).toHaveLength(1)
    expect(connecting[0].iconKey).toBe('connection')
  })

  it('exposes F0 through activeBannerIds so the dismissal pruning stays consistent', () => {
    expect([...activeBannerIds(nominalInput({ chatSupport: 'unsupported' }))]).toEqual(['runtime-unsupported:machine-1'])
  })
})
