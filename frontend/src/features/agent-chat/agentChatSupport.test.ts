import { describe, expect, it } from 'vitest'

import { agentChatSupport } from '@/features/agent-chat/agentChatSupport'
import type { Machine } from '@/store/types'

const machine: Machine = {
  id: 'm-1',
  name: 'superapps-dev-02',
  url: 'http://m-1:7777',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

describe('agentChatSupport', () => {
  it('is supported when the runtime advertises the capability', () => {
    expect(agentChatSupport({ machine, capabilities: ['ssh-chat', 'agent-chat'] })).toBe('supported')
  })

  it('is unsupported only when the runtime answered WITHOUT the capability', () => {
    expect(agentChatSupport({ machine, capabilities: ['ssh-chat'] })).toBe('unsupported')
    expect(agentChatSupport({ machine, capabilities: [] })).toBe('unsupported')
  })

  // The rule that separates this from sshChatAvailability, and the one most
  // likely to be "simplified" into a bug later.
  //
  // Worktree chat predates capability reporting entirely, so EVERY runtime not
  // yet upgraded to the build that introduced `capabilities` reports no list
  // while serving chat perfectly well. Treating that as unsupported would tell
  // operators to update machines that are working, and would black out their
  // chat panes to do it.
  it('does NOT call a runtime unsupported just because it reports no capability list', () => {
    expect(agentChatSupport({ machine, capabilities: null })).toBe('unknown')
  })

  it('is unknown while the probe is still in flight', () => {
    expect(agentChatSupport({ machine, capabilities: undefined })).toBe('unknown')
  })

  // The SSH panel targets the hub and gates itself upstream; asking here would
  // answer for the wrong process.
  it('is unknown when there is no runtime machine to ask', () => {
    expect(agentChatSupport({ machine: undefined, capabilities: ['ssh-chat'] })).toBe('unknown')
  })
})
