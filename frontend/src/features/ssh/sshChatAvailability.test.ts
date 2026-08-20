import { describe, expect, it } from 'vitest'

import { sshChatAvailability, sshChatUnavailableMessage } from '@/features/ssh/sshChatAvailability'
import type { Machine, SSHConnection } from '@/store/types'

function machine(id: string, name = id): Machine {
  return { id, name, url: `http://${id}:7777`, key: 'k', isLocal: false, signingPublicKey: '' }
}

function connection(executorMachineId: string | null): SSHConnection {
  return {
    id: 'sc-1',
    name: 'prod-01',
    group: '',
    host: '10.0.0.5',
    port: 22,
    username: 'clouduser',
    authType: 'password',
    jumpConnectionId: null,
    executorMachineId,
    hostKeyFingerprint: null,
  }
}

describe('sshChatAvailability', () => {
  it('targets the connection’s executor runtime once it reports the capability', () => {
    const m = machine('m-1', 'superapps-dev-02')
    const a = sshChatAvailability({
      connection: connection('m-1'),
      machines: [machine('m-0'), m],
      capabilities: ['ssh-chat'],
    })
    expect(a).toEqual({ kind: 'ready', machine: m })
    expect(sshChatUnavailableMessage(a)).toBeNull()
  })

  // The regression this whole gate exists for: a connection pinned to a runtime
  // used to open its chat against the hub anyway.
  it('never resolves to the hub for a connection with an executor', () => {
    const a = sshChatAvailability({
      connection: connection('m-1'),
      machines: [machine('m-1')],
      capabilities: ['ssh-chat'],
    })
    expect(a.kind).toBe('ready')
    if (a.kind === 'ready') expect(a.machine.id).toBe('m-1')
  })

  it('reports a runtime that does not advertise the capability as out of date', () => {
    const a = sshChatAvailability({
      connection: connection('m-1'),
      machines: [machine('m-1', 'superapps-dev-02')],
      capabilities: ['some-other-feature'],
    })
    expect(a.kind).toBe('outdated')
    expect(sshChatUnavailableMessage(a)).toContain('Update it to the latest version')
    expect(sshChatUnavailableMessage(a)).toContain('superapps-dev-02')
  })

  // A build that predates capability reporting sends no array at all. That is
  // the MOST likely shape of a genuinely old runtime, so it must land on the
  // same "update it" message rather than falling through to ready.
  it('treats a missing capability list as out of date, not as capable', () => {
    const a = sshChatAvailability({
      connection: connection('m-1'),
      machines: [machine('m-1')],
      capabilities: null,
    })
    expect(a.kind).toBe('outdated')
  })

  it('asks the operator to assign an executor when the connection has none', () => {
    const a = sshChatAvailability({ connection: connection(null), machines: [machine('m-1')], capabilities: undefined })
    expect(a.kind).toBe('no-executor')
    expect(sshChatUnavailableMessage(a, 'prod-01')).toContain('prod-01')
    expect(sshChatUnavailableMessage(a)).toContain('Pick an executor machine')
  })

  it('distinguishes an unreachable runtime from an out-of-date one', () => {
    const a = sshChatAvailability({
      connection: connection('m-1'),
      machines: [machine('m-1', 'superapps-dev-02')],
      capabilities: undefined,
      capabilitiesFailed: true,
    })
    expect(a.kind).toBe('unreachable')
    // Telling someone to update a machine that is merely offline sends them to
    // fix the wrong thing.
    expect(sshChatUnavailableMessage(a)).not.toContain('Update it')
    expect(sshChatUnavailableMessage(a)).toContain('needs to be online')
  })

  it('reports an executor that is no longer in the registry', () => {
    const a = sshChatAvailability({ connection: connection('m-gone'), machines: [machine('m-1')], capabilities: undefined })
    expect(a).toEqual({ kind: 'unknown-machine', machineId: 'm-gone' })
    expect(sshChatUnavailableMessage(a)).toContain('m-gone')
  })

  // Every "not yet" case must be loading, never an accusation. A panel that
  // flashes "update your runtime" for one frame on every open is worse than one
  // that shows nothing for that frame.
  describe('while data is still in flight', () => {
    it('is loading before the connection resolves', () => {
      expect(sshChatAvailability({ connection: undefined, machines: [machine('m-1')], capabilities: ['ssh-chat'] }).kind)
        .toBe('loading')
    })

    it('is loading before the machine registry resolves', () => {
      expect(sshChatAvailability({ connection: connection('m-1'), machines: undefined, capabilities: ['ssh-chat'] }).kind)
        .toBe('loading')
    })

    it('is loading before the capability probe answers', () => {
      expect(sshChatAvailability({ connection: connection('m-1'), machines: [machine('m-1')], capabilities: undefined }).kind)
        .toBe('loading')
    })
  })
})
