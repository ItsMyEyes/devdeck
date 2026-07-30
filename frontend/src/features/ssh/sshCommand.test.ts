/**
 * Plain assertion-based tests, matching jumpHostDraft.test.ts's convention
 * (no Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/ssh/sshCommand.test.ts
 */

import { parseSSHCommand } from './sshCommand'

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

check('parses the spec example: destination first, -J after it', () => {
  const parsed = parseSSHCommand('ssh root@10.1.1.1 -J root@2131')
  assertEqual(parsed?.target, { user: 'root', host: '10.1.1.1', port: 22 }, 'target')
  assertEqual(parsed?.jumps, [{ user: 'root', host: '2131', port: 22 }], 'jumps')
  assertEqual(parsed?.identityFile, null, 'no identity file')
  assertEqual(parsed?.ignoredFlags, [], 'nothing ignored')
})

check('parses a bare user@host with no ssh prefix', () => {
  const parsed = parseSSHCommand('deploy@web.example.com')
  assertEqual(parsed?.target, { user: 'deploy', host: 'web.example.com', port: 22 }, 'target')
  assertEqual(parsed?.jumps, [], 'no jumps')
})

check('a destination with no user parses with an empty user', () => {
  const parsed = parseSSHCommand('ssh myhost')
  assertEqual(parsed?.target, { user: '', host: 'myhost', port: 22 }, 'target')
})

check('reads -p and -l in both attached and detached spellings', () => {
  assertEqual(parseSSHCommand('ssh -p 2222 host')?.target.port, 2222, 'detached -p')
  assertEqual(parseSSHCommand('ssh -p2222 host')?.target.port, 2222, 'attached -p')
  assertEqual(parseSSHCommand('ssh -l deploy host')?.target.user, 'deploy', 'detached -l')
  assertEqual(parseSSHCommand('ssh -ldeploy host')?.target.user, 'deploy', 'attached -l')
})

check('a user@ in the destination beats -l', () => {
  assertEqual(parseSSHCommand('ssh -l ignored root@host')?.target.user, 'root', 'destination user wins')
})

check('accepts host:port in the destination, but -p overrides it', () => {
  assertEqual(parseSSHCommand('ssh root@host:2200')?.target.port, 2200, 'host:port read')
  assertEqual(parseSSHCommand('ssh -p 22 root@host:2200')?.target.port, 22, '-p wins')
})

check('reads -i, including a quoted path with spaces', () => {
  assertEqual(parseSSHCommand('ssh -i ~/.ssh/id_ed25519 root@host')?.identityFile, '~/.ssh/id_ed25519', 'plain path')
  assertEqual(parseSSHCommand('ssh -i "/keys/my key.pem" root@host')?.identityFile, '/keys/my key.pem', 'quoted path')
})

check('reads a multi-hop comma-separated -J, nearest hop first', () => {
  const parsed = parseSSHCommand('ssh root@target -J a@first:2222,b@second')
  assertEqual(
    parsed?.jumps,
    [
      { user: 'a', host: 'first', port: 2222 },
      { user: 'b', host: 'second', port: 22 },
    ],
    'both hops in order',
  )
})

check('a jump hop with no user inherits the target user', () => {
  assertEqual(parseSSHCommand('ssh root@target -J bastion')?.jumps, [{ user: 'root', host: 'bastion', port: 22 }], 'inherited')
})

check('-o consumes its value so it is never mistaken for the destination', () => {
  const parsed = parseSSHCommand('ssh -o StrictHostKeyChecking=no root@host')
  assertEqual(parsed?.target.host, 'host', 'destination is the real host')
  assertEqual(parsed?.ignoredFlags, ['-o'], 'flag recorded')
})

check('unknown valueless flags are recorded once each, deduped', () => {
  const parsed = parseSSHCommand('ssh -A -t -t --config root@host')
  assertEqual(parsed?.target.host, 'host', 'destination found')
  assertEqual(parsed?.ignoredFlags, ['-A', '-t', '--config'], 'deduped, in order')
})

check('a remote command after the destination is ignored entirely', () => {
  const parsed = parseSSHCommand('ssh root@host tail -f /var/log/syslog')
  assertEqual(parsed?.target.host, 'host', 'destination')
  assertEqual(parsed?.ignoredFlags, [], 'the remote command contributes no ignored flags')
})

check('a multi-colon host is taken verbatim with no port split', () => {
  assertEqual(parseSSHCommand('ssh root@::1')?.target, { user: 'root', host: '::1', port: 22 }, 'bare IPv6 host')
})

check('returns null when there is no destination', () => {
  assertEqual(parseSSHCommand('ssh -p 22'), null, 'flags only')
  assertEqual(parseSSHCommand('   '), null, 'blank')
})

check('a bare "-" token is recorded verbatim, not as "-undefined"', () => {
  const parsed = parseSSHCommand('ssh - root@host')
  assertEqual(parsed?.target, { user: 'root', host: 'host', port: 22 }, 'destination still parses')
  assertEqual(parsed?.ignoredFlags, ['-'], 'bare dash recorded as itself')
})

console.log(`\n${passed} tests passed`)
