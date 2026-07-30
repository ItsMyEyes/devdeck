/**
 * Plain assertion-based tests, matching jumpHostDraft.test.ts's convention
 * (no Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/ssh/sshQuickAdd.test.ts
 */

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

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

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

check('deriveSSHQuickAddName uses user@host, or the bare host with no user', () => {
  assertEqual(deriveSSHQuickAddName(parse('ssh root@10.1.1.1')), 'root@10.1.1.1', 'with user')
  assertEqual(deriveSSHQuickAddName(parse('ssh myhost')), 'myhost', 'without user')
})

check('a fresh draft is untouched, unnamed, hub-decides, and password-auth', () => {
  const fresh = defaultSSHQuickAddDraft()
  assertEqual(fresh.name, '', 'no name')
  assertEqual(fresh.nameTouched, false, 'name not hand-edited yet')
  assertEqual(fresh.executorMachineId, '', 'hub decides')
  assertEqual(fresh.jumpAuthOverride, false, 'hops reuse the target credentials')
  assertEqual(fresh.auth.authType, 'password', 'password auth by default')
})

check('applyIdentityFile switches to private-key auth and clears a pasted key', () => {
  const before = { ...defaultSSHQuickAddDraft(), auth: { ...defaultSSHQuickAddDraft().auth, privateKey: 'STALE' } }
  const after = applyIdentityFile(before, parse('ssh -i ~/.ssh/id_ed25519 root@host'))
  assertEqual(after.auth.authType, 'privatekey', 'auth type switched')
  assertEqual(after.auth.privateKeyPath, '~/.ssh/id_ed25519', 'path set')
  assertEqual(after.auth.privateKey, '', 'stale pasted key cleared')
})

check('applyIdentityFile leaves the draft untouched when there is no -i', () => {
  const before = defaultSSHQuickAddDraft()
  assertEqual(applyIdentityFile(before, parse('ssh root@host')), before, 'unchanged')
})

check('findExistingConnection matches on host/port/user, host case-insensitively', () => {
  const saved = [connection({ id: 'sc-9', host: 'Bastion.Example.com' })]
  const hop = parse('ssh root@target -J root@bastion.example.com').jumps[0]
  assertEqual(findExistingConnection(hop, saved)?.id, 'sc-9', 'matched')
  assertEqual(findExistingConnection(hop, [connection({ port: 2222 })]), undefined, 'port must match')
  assertEqual(findExistingConnection(hop, [connection({ username: 'deploy' })]), undefined, 'user must match')
})

check('isSSHQuickAddValid rejects a missing username, bad port, and missing secret', () => {
  const base = defaultSSHQuickAddDraft()
  assertEqual(
    isSSHQuickAddValid(parse('ssh myhost'), draftFor('ssh myhost'), []),
    false,
    'no username',
  )
  assertEqual(
    isSSHQuickAddValid(parse('ssh -p 99999 root@host'), draftFor('ssh -p 99999 root@host'), []),
    false,
    'port out of range',
  )
  assertEqual(
    isSSHQuickAddValid(parse('ssh root@host'), { ...draftFor('ssh root@host'), auth: base.auth }, []),
    false,
    'no secret',
  )
  assertEqual(
    isSSHQuickAddValid(parse('ssh root@host'), { ...draftFor('ssh root@host'), name: '  ' }, []),
    false,
    'blank name',
  )
  assertEqual(isSSHQuickAddValid(null, draftFor('ssh root@host'), []), false, 'unparsed command')
  assertEqual(isSSHQuickAddValid(parse('ssh root@host'), draftFor('ssh root@host'), []), true, 'complete draft')
})

check('isSSHQuickAddValid only demands jump credentials when a hop will be created', () => {
  const raw = 'ssh root@target -J root@bastion.example.com'
  const overridden = { ...draftFor(raw), jumpAuthOverride: true }
  assertEqual(isSSHQuickAddValid(parse(raw), overridden, []), false, 'override on, no jump secret')
  assertEqual(
    isSSHQuickAddValid(parse(raw), overridden, [connection({})]),
    true,
    'hop already saved, so the empty jump auth is irrelevant',
  )
})

check('buildSSHQuickAddPlan puts the target last with the draft name and executor', () => {
  const raw = 'ssh root@10.1.1.1'
  const plan = buildSSHQuickAddPlan(parse(raw), { ...draftFor(raw), name: 'prod-web', executorMachineId: 'm-1' }, [])
  assertEqual(plan.steps.length, 1, 'one step')
  const step = plan.steps[0]
  if (step.kind !== 'create') throw new Error('expected a create step')
  assertEqual(step.body.name, 'prod-web', 'draft name used')
  assertEqual(step.body.host, '10.1.1.1', 'host')
  assertEqual(step.body.port, 22, 'port')
  assertEqual(step.body.username, 'root', 'username')
  assertEqual(step.body.executorMachineId, 'm-1', 'executor carried')
  assertEqual(step.body.jumpConnectionId, null, 'caller threads the jump id')
  assertEqual(step.body.password, 'hunter2', 'secret carried')
})

check('an empty executor selection becomes null, not an empty string', () => {
  const raw = 'ssh root@host'
  const plan = buildSSHQuickAddPlan(parse(raw), { ...draftFor(raw), executorMachineId: '' }, [])
  const step = plan.steps[0]
  if (step.kind !== 'create') throw new Error('expected a create step')
  assertEqual(step.body.executorMachineId, null, 'hub decides')
})

check('buildSSHQuickAddPlan orders a multi-hop chain farthest hop first', () => {
  const raw = 'ssh root@target -J root@near,root@far'
  const plan = buildSSHQuickAddPlan(parse(raw), draftFor(raw), [])
  const hosts = plan.steps.map((s) => (s.kind === 'create' ? s.body.host : `existing:${s.id}`))
  assertEqual(hosts, ['far', 'near', 'target'], 'farthest, nearest, target')
})

check('hop bodies are ungrouped, executor-less, and auto-named', () => {
  const raw = 'ssh root@target -J deploy@bastion:2222'
  const plan = buildSSHQuickAddPlan(parse(raw), draftFor(raw), [])
  const hop = plan.steps[0]
  if (hop.kind !== 'create') throw new Error('expected a create step')
  assertEqual(hop.body.name, 'deploy@bastion', 'auto-named')
  assertEqual(hop.body.group, '', 'ungrouped')
  assertEqual(hop.body.port, 2222, 'hop port')
  assertEqual(hop.body.executorMachineId, null, 'no executor on an intermediate hop')
})

check('a saved hop becomes an existing step instead of a duplicate create', () => {
  const raw = 'ssh root@target -J root@bastion.example.com'
  const plan = buildSSHQuickAddPlan(parse(raw), draftFor(raw), [connection({ id: 'sc-7' })])
  assertEqual(plan.steps[0], { kind: 'existing', id: 'sc-7' }, 'reused')
  assertEqual(plan.steps.length, 2, 'reuse plus the target')
})

check('the target is always created even when an identical host is already saved', () => {
  const raw = 'ssh root@bastion.example.com'
  const plan = buildSSHQuickAddPlan(parse(raw), draftFor(raw), [connection({ id: 'sc-7' })])
  assertEqual(plan.steps[0].kind, 'create', 'target never reused')
})

check('hops use the jump credentials only when the override is on', () => {
  const raw = 'ssh root@target -J root@bastion'
  const shared = buildSSHQuickAddPlan(parse(raw), draftFor(raw), []).steps[0]
  if (shared.kind !== 'create') throw new Error('expected a create step')
  assertEqual(shared.body.password, 'hunter2', 'target credentials reused by default')

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
  assertEqual(overridden.body.password, 'jumppw', 'override applied to the hop')
})

check('private-key auth prefers a pasted key over a path and omits blank fields', () => {
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
  assertEqual(step.body.privateKey, 'PEMDATA', 'pasted key wins')
  assertEqual(step.body.privateKeyPath, undefined, 'path omitted')
  assertEqual(step.body.passphrase, 'shh', 'passphrase carried')
  assertEqual(step.body.password, undefined, 'no password field')
})

console.log(`\n${passed} tests passed`)
