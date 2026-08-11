import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentChatEnabled } from './enabled'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('agentChatEnabled', () => {
  // The whole point of the gate: a shipped build hides the feature unless
  // someone opts in at build time.
  it('is off in a production build with no override', () => {
    vi.stubEnv('PROD', true)

    expect(agentChatEnabled()).toBe(false)
  })

  it('is on outside a production build with no override', () => {
    vi.stubEnv('PROD', false)

    expect(agentChatEnabled()).toBe(true)
  })

  it.each(['1', 'on'])('is on in a production build when VITE_AGENT_CHAT=%s', (flag) => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_AGENT_CHAT', flag)

    expect(agentChatEnabled()).toBe(true)
  })

  it.each(['0', 'off'])('is off outside a production build when VITE_AGENT_CHAT=%s', (flag) => {
    vi.stubEnv('PROD', false)
    vi.stubEnv('VITE_AGENT_CHAT', flag)

    expect(agentChatEnabled()).toBe(false)
  })

  // An unrecognised value is a typo, not an intent — fall through to the
  // build-mode default rather than silently picking one.
  it('ignores an unrecognised value and falls back to the build mode', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_AGENT_CHAT', 'true')

    expect(agentChatEnabled()).toBe(false)
  })
})
