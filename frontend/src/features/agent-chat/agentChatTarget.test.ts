/**
 * Task 11 (`docs/superpowers/plans/2026-08-17-ssh-devops-chat.md`): the chat
 * socket now routes by an explicit `AgentChatTarget` instead of always being
 * handed a `Machine` — worktree threads dial their runtime through
 * `machineWsUrl` exactly as before, SSH threads dial the hub directly, the
 * same way `sshClient.ts`'s `sshShellWsUrl` builds `/ws/ssh`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentChatWsUrl } from '@/features/agent-chat/useAgentChatSocket'
import { machineWsUrl } from '@/lib/machineClient'
import type { Machine } from '@/store/types'

vi.mock('@/lib/machineClient', () => ({
  machineWsUrl: vi.fn(async () => 'wss://runtime.example.com/ws/agent?key=abc'),
}))

const machine: Machine = { id: 'm-1', name: 'dev-machine', url: '', key: '', isLocal: false, signingPublicKey: '' }

describe('agentChatWsUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds a hub-direct URL from window.location for SSH threads', async () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'deck.example.com' } as Location)
    await expect(agentChatWsUrl({ kind: 'hub' })).resolves.toBe('wss://deck.example.com/ws/agent')
  })

  it('uses ws:// on a plain-http hub', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' } as Location)
    await expect(agentChatWsUrl({ kind: 'hub' })).resolves.toBe('ws://localhost:5173/ws/agent')
  })

  it('routes the machine branch through machineWsUrl with the /agent path, unchanged', async () => {
    const url = await agentChatWsUrl({ kind: 'machine', machine })
    expect(machineWsUrl).toHaveBeenCalledWith(machine, '/agent', {})
    expect(url).toBe('wss://runtime.example.com/ws/agent?key=abc')
  })
})
