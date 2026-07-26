/**
 * Plain assertion-based tests, matching ripgrepInstallPrefs.test.ts's
 * convention (no Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/ssh/jumpHostDraft.test.ts
 */

import { buildJumpHostRequest, defaultJumpHostDraft, isJumpHostDraftValid, type JumpHostDraft } from './jumpHostDraft'

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

function passwordDraft(overrides: Partial<JumpHostDraft> = {}): JumpHostDraft {
  return { ...defaultJumpHostDraft(), host: 'bastion.example.com', username: 'deploy', password: 'hunter2', ...overrides }
}

check('defaultJumpHostDraft starts on port 22, password auth, everything else blank', () => {
  assertEqual(
    defaultJumpHostDraft(),
    { host: '', port: '22', username: '', authType: 'password', password: '', privateKey: '', privateKeyPath: '', passphrase: '' },
    'default draft shape',
  )
})

check('a fully filled-in password draft is valid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft()), true, 'valid password draft')
})

check('blank host is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ host: '  ' })), false, 'blank host')
})

check('blank username is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ username: '' })), false, 'blank username')
})

check('port 0 is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ port: '0' })), false, 'port too low')
})

check('port 65536 is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ port: '65536' })), false, 'port too high')
})

check('non-numeric port is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ port: 'abc' })), false, 'non-numeric port')
})

check('password auth with an empty password is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ password: '' })), false, 'empty password')
})

check('privatekey auth with neither key nor path is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ authType: 'privatekey', password: '' })), false, 'no key material')
})

check('privatekey auth with a pasted key is valid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ authType: 'privatekey', password: '', privateKey: '-----BEGIN...' })), true, 'pasted key')
})

check('privatekey auth with only a path is valid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ authType: 'privatekey', password: '', privateKeyPath: '~/.ssh/id_ed25519' })), true, 'key path')
})

check('buildJumpHostRequest names the connection after the trimmed host, ungrouped, single hop', () => {
  const body = buildJumpHostRequest(passwordDraft({ host: '  bastion.example.com  ', port: '2222' }))
  assertEqual(body.name, 'bastion.example.com', 'name mirrors trimmed host')
  assertEqual(body.host, 'bastion.example.com', 'host trimmed')
  assertEqual(body.group, '', 'ungrouped')
  assertEqual(body.port, 2222, 'port parsed to a number')
  assertEqual(body.executorMachineId, null, 'no executor')
  assertEqual(body.jumpConnectionId, null, 'no chained jump of its own')
})

check('buildJumpHostRequest for password auth carries the password, not key fields', () => {
  const body = buildJumpHostRequest(passwordDraft({ password: 'hunter2' }))
  assertEqual(body.password, 'hunter2', 'password carried')
  assertEqual(body.privateKey, undefined, 'no privateKey field')
  assertEqual(body.privateKeyPath, undefined, 'no privateKeyPath field')
  assertEqual(body.passphrase, undefined, 'no passphrase field')
})

check('buildJumpHostRequest for privatekey auth carries the key and passphrase, not password', () => {
  const body = buildJumpHostRequest(
    passwordDraft({ authType: 'privatekey', password: '', privateKey: 'PEMDATA', passphrase: 'shh' }),
  )
  assertEqual(body.privateKey, 'PEMDATA', 'privateKey carried')
  assertEqual(body.passphrase, 'shh', 'passphrase carried')
  assertEqual(body.password, undefined, 'no password field')
})

check('buildJumpHostRequest prefers a pasted privateKey over privateKeyPath when both are set', () => {
  const body = buildJumpHostRequest(
    passwordDraft({ authType: 'privatekey', password: '', privateKey: 'PEMDATA', privateKeyPath: '~/.ssh/id_ed25519' }),
  )
  assertEqual(body.privateKey, 'PEMDATA', 'pasted key wins')
  assertEqual(body.privateKeyPath, undefined, 'path omitted when key present')
})

console.log(`\n${passed} tests passed`)
