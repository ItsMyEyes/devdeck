import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { machineWsUrl } from '@/lib/machineClient'
import { AGENT_WS_PATH } from '@/features/agent-chat/useAgentChatSocket'
import type { Machine } from '@/store/types'

/**
 * Guards the one trap every `/ws/...` caller can fall into: `machineWsUrl`
 * already appends `/ws` to both the direct and proxy bases, so the `path`
 * argument must be the bare route (`/terminal`, `/lsp`, `/agent`) and never
 * `/ws/terminal`. Passing the `/ws`-prefixed form yields `wss://host/ws/ws/...`
 * and every connection dies with a 400 — which is exactly how the agent-chat
 * socket shipped before this test existed.
 */

function machine(id: string): Machine {
  return {
    id,
    name: 'test-runtime',
    url: 'https://runtime.example.ts.net',
    key: 'test-key',
  } as Machine
}

describe('machineWsUrl', () => {
  beforeEach(() => {
    // Make the direct probe succeed so we exercise the direct branch; each
    // test uses a distinct machine id so machineClient's mode cache can't
    // leak a decision between them.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Uses the constant the agent-chat hook actually passes, so reintroducing
  // the '/ws/agent' form fails here rather than only in a live browser.
  it('appends /ws itself, so the agent hook’s bare route reaches /ws/agent', async () => {
    expect(AGENT_WS_PATH.startsWith('/ws')).toBe(false)

    const url = await machineWsUrl(machine('m-agent'), AGENT_WS_PATH, {})
    expect(url).toContain('/ws/agent?')
    expect(url).not.toContain('/ws/ws/')
  })

  it('produces the same shape for the terminal and lsp routes', async () => {
    const term = await machineWsUrl(machine('m-term'), '/terminal', { session: 'w-abc' })
    expect(term).toContain('/ws/terminal?')
    expect(term).not.toContain('/ws/ws/')

    const lsp = await machineWsUrl(machine('m-lsp'), '/lsp', { worktree: 'w-abc', language: 'go' })
    expect(lsp).toContain('/ws/lsp?')
    expect(lsp).not.toContain('/ws/ws/')
  })

  it('double-prefixes if a caller passes /ws itself — the failure this guards', async () => {
    // Documents the actual behaviour rather than asserting a fix: machineWsUrl
    // does not defend against this, so the contract lives in its callers.
    const url = await machineWsUrl(machine('m-double'), '/ws/agent', {})
    expect(url).toContain('/ws/ws/agent')
  })

  it('switches http to ws and carries the runtime key in direct mode', async () => {
    const url = await machineWsUrl(machine('m-scheme'), '/agent', {})
    expect(url.startsWith('wss://')).toBe(true)
    expect(url).toContain('key=test-key')
  })
})
