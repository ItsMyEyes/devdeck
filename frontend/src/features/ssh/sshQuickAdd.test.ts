import { describe, expect, it } from 'vitest'
import type { SSHConnection } from '@/store/types'
import { parseSSHCommand } from './sshCommand'
import {
  applyIdentityFile,
  buildSSHQuickAddPlan,
  defaultSSHQuickAddDraft,
  deriveSSHQuickAddName,
  findExistingConnection,
  isSSHQuickAddValid,
  type SSHQuickAddDraft,
} from './sshQuickAdd'

function parse(raw: string) {
  const parsed = parseSSHCommand(raw)
  if (!parsed) throw new Error(`fixture failed to parse: ${raw}`)
  return parsed
}

function draftFor(raw: string, overrides: Partial<SSHQuickAddDraft> = {}): SSHQuickAddDraft {
  const base = defaultSSHQuickAddDraft()
  return {
    ...base,
    raw,
    name: deriveSSHQuickAddName(parse(raw)),
    auth: { ...base.auth, password: 'hunter2' },
    ...overrides,
  }
}

function connection(overrides: Partial<SSHConnection>): SSHConnection {
  return {
    id: 'sc-1',
    name: 'bastion',
    group: '',
    host: 'bastion.example.com',
    port: 22,
    username: 'root',
    authType: 'password',
    jumpConnectionId: null,
    executorMachineId: null,
    hostKeyFingerprint: null,
    ...overrides,
  }
}

describe('sshQuickAdd', () => {
  it('deriveSSHQuickAddName uses user@host, or the bare host with no user', () => {
    expect(deriveSSHQuickAddName(parse('ssh root@10.1.1.1'))).toBe('root@10.1.1.1')
    expect(deriveSSHQuickAddName(parse('ssh myhost'))).toBe('myhost')
  })

  it('a fresh draft is untouched, unnamed, hub-decides, and password-auth', () => {
    const fresh = defaultSSHQuickAddDraft()
    expect(fresh.name).toBe('')
    expect(fresh.nameTouched).toBe(false)
    expect(fresh.executorMachineId).toBe('')
    expect(fresh.jumpAuthOverride).toBe(false)
    expect(fresh.auth.authType).toBe('password')
  })

  it('applyIdentityFile switches to private-key auth and clears a pasted key', () => {
    const before = { ...defaultSSHQuickAddDraft(), auth: { ...defaultSSHQuickAddDraft().auth, privateKey: 'STALE' } }
    const after = applyIdentityFile(before, parse('ssh -i ~/.ssh/id_ed25519 root@host'))
    expect(after.auth.authType).toBe('privatekey')
    expect(after.auth.privateKeyPath).toBe('~/.ssh/id_ed25519')
    expect(after.auth.privateKey).toBe('')
  })

  it('applyIdentityFile leaves the draft untouched when there is no -i', () => {
    const before = defaultSSHQuickAddDraft()
    expect(applyIdentityFile(before, parse('ssh root@host'))).toEqual(before)
  })

  it('findExistingConnection matches on host/port/user, host case-insensitively', () => {
    const saved = [connection({ id: 'sc-9', host: 'Bastion.Example.com' })]
    const hop = parse('ssh root@target -J root@bastion.example.com').jumps[0]
    expect(findExistingConnection(hop, saved)?.id).toBe('sc-9')
    expect(findExistingConnection(hop, [connection({ port: 2222 })])).toBeUndefined()
    expect(findExistingConnection(hop, [connection({ username: 'deploy' })])).toBeUndefined()
  })

  it('isSSHQuickAddValid rejects a missing username, bad port, and missing secret', () => {
    const base = defaultSSHQuickAddDraft()
    expect(isSSHQuickAddValid(parse('ssh myhost'), draftFor('ssh myhost'), [])).toBe(false)
    expect(isSSHQuickAddValid(parse('ssh -p 99999 root@host'), draftFor('ssh -p 99999 root@host'), [])).toBe(false)
    expect(
      isSSHQuickAddValid(parse('ssh root@host'), { ...draftFor('ssh root@host'), auth: base.auth }, []),
    ).toBe(false)
    expect(isSSHQuickAddValid(parse('ssh root@host'), { ...draftFor('ssh root@host'), name: '  ' }, [])).toBe(false)
    expect(isSSHQuickAddValid(null, draftFor('ssh root@host'), [])).toBe(false)
    expect(isSSHQuickAddValid(parse('ssh root@host'), draftFor('ssh root@host'), [])).toBe(true)
  })

  it('isSSHQuickAddValid only demands jump credentials when a hop will be created', () => {
    const raw = 'ssh root@target -J root@bastion.example.com'
    const overridden = { ...draftFor(raw), jumpAuthOverride: true }
    expect(isSSHQuickAddValid(parse(raw), overridden, [])).toBe(false)
    expect(isSSHQuickAddValid(parse(raw), overridden, [connection({})])).toBe(true)
  })

  it('buildSSHQuickAddPlan puts the target last with the draft name and executor', () => {
    const raw = 'ssh root@10.1.1.1'
    const plan = buildSSHQuickAddPlan(parse(raw), { ...draftFor(raw), name: 'prod-web', executorMachineId: 'm-1' }, [])
    expect(plan.steps.length).toBe(1)
    const step = plan.steps[0]
    if (step.kind !== 'create') throw new Error('expected a create step')
    expect(step.body.name).toBe('prod-web')
    expect(step.body.host).toBe('10.1.1.1')
    expect(step.body.port).toBe(22)
    expect(step.body.username).toBe('root')
    expect(step.body.executorMachineId).toBe('m-1')
    expect(step.body.jumpConnectionId).toBe(null)
    expect(step.body.password).toBe('hunter2')
  })

  it('an empty executor selection becomes null, not an empty string', () => {
    const raw = 'ssh root@host'
    const plan = buildSSHQuickAddPlan(parse(raw), { ...draftFor(raw), executorMachineId: '' }, [])
    const step = plan.steps[0]
    if (step.kind !== 'create') throw new Error('expected a create step')
    expect(step.body.executorMachineId).toBe(null)
  })

  it('buildSSHQuickAddPlan orders a multi-hop chain nearest-hub hop first', () => {
    // Regression: this order must match ssh(1)'s own dial order (and
    // sshmgr.Dialer's semantics — see backend/internal/sshmgr/dialer_test.go's
    // TestDialThroughJumpConnectionChainOfTwo), so the caller (NewTabDialog's
    // runPlan) can thread each created row's id into the next step's
    // `jumpConnectionId` and end up with the hub dialing `near` directly, then
    // `far` via `near`, then `target` via `far` — not the reverse.
    const raw = 'ssh root@target -J root@near,root@far'
    const plan = buildSSHQuickAddPlan(parse(raw), draftFor(raw), [])
    const hosts = plan.steps.map((s) => (s.kind === 'create' ? s.body.host : `existing:${s.id}`))
    expect(hosts).toEqual(['near', 'far', 'target'])
  })

  it('hop bodies are ungrouped, executor-less, and auto-named', () => {
    const raw = 'ssh root@target -J deploy@bastion:2222'
    const plan = buildSSHQuickAddPlan(parse(raw), draftFor(raw), [])
    const hop = plan.steps[0]
    if (hop.kind !== 'create') throw new Error('expected a create step')
    expect(hop.body.name).toBe('deploy@bastion')
    expect(hop.body.group).toBe('')
    expect(hop.body.port).toBe(2222)
    expect(hop.body.executorMachineId).toBe(null)
  })

  it('a saved hop becomes an existing step instead of a duplicate create', () => {
    const raw = 'ssh root@target -J root@bastion.example.com'
    const plan = buildSSHQuickAddPlan(parse(raw), draftFor(raw), [connection({ id: 'sc-7' })])
    expect(plan.steps[0]).toEqual({ kind: 'existing', id: 'sc-7' })
    expect(plan.steps.length).toBe(2)
  })

  it('the target is always created even when an identical host is already saved', () => {
    const raw = 'ssh root@bastion.example.com'
    const plan = buildSSHQuickAddPlan(parse(raw), draftFor(raw), [connection({ id: 'sc-7' })])
    expect(plan.steps[0].kind).toBe('create')
  })

  it('hops use the jump credentials only when the override is on', () => {
    const raw = 'ssh root@target -J root@bastion'
    const shared = buildSSHQuickAddPlan(parse(raw), draftFor(raw), []).steps[0]
    if (shared.kind !== 'create') throw new Error('expected a create step')
    expect(shared.body.password).toBe('hunter2')

    const overridden = buildSSHQuickAddPlan(
      parse(raw),
      {
        ...draftFor(raw),
        jumpAuthOverride: true,
        jumpAuth: { authType: 'password', password: 'jumppw', privateKey: '', privateKeyPath: '', passphrase: '' },
      },
      [],
    ).steps[0]
    if (overridden.kind !== 'create') throw new Error('expected a create step')
    expect(overridden.body.password).toBe('jumppw')
  })

  it('private-key auth prefers a pasted key over a path and omits blank fields', () => {
    const raw = 'ssh root@host'
    const plan = buildSSHQuickAddPlan(
      parse(raw),
      {
        ...draftFor(raw),
        auth: {
          authType: 'privatekey',
          password: '',
          privateKey: 'PEMDATA',
          privateKeyPath: '~/.ssh/id_ed25519',
          passphrase: 'shh',
        },
      },
      [],
    )
    const step = plan.steps[0]
    if (step.kind !== 'create') throw new Error('expected a create step')
    expect(step.body.privateKey).toBe('PEMDATA')
    expect(step.body.privateKeyPath).toBeUndefined()
    expect(step.body.passphrase).toBe('shh')
    expect(step.body.password).toBeUndefined()
  })
})
