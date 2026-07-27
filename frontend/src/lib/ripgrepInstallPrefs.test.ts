/**
 * Plain assertion-based tests, matching dbTabs.test.ts's convention (no
 * Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/lib/ripgrepInstallPrefs.test.ts
 *
 * Covers the design's Testing section bullet: "unit tests for ... the
 * per-target dismissed-banner localStorage logic" and the worktree-vs-ssh
 * target-id derivation dismissRipgrepInstall/isRipgrepInstallDismissed key
 * on (a regression here would make the banner reappear every search, or
 * never reappear for a different target).
 */

// ripgrepInstallPrefs.ts reads/writes `window.localStorage` lazily, inside
// function bodies rather than at module load time, so installing a minimal
// in-memory stand-in on globalThis before the assertions run is enough to
// exercise the real persistence logic under plain Node (tsx) the same way
// the browser would.
class FakeLocalStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
}

;(globalThis as unknown as { window: { localStorage: FakeLocalStorage } }).window = { localStorage: new FakeLocalStorage() }

import { dismissRipgrepInstall, isRipgrepInstallDismissed, ripgrepInstallTargetId } from './ripgrepInstallPrefs'
import type { FilesTarget } from '@/features/terminal/filesTarget'
import type { Machine } from '@/store/types'

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

const machineA: Machine = { id: 'm-aaa', name: 'a', url: '', key: '', isLocal: false, signingPublicKey: '' }
const machineB: Machine = { id: 'm-bbb', name: 'b', url: '', key: '', isLocal: false, signingPublicKey: '' }

const worktreeTargetA: FilesTarget = { kind: 'worktree', machine: machineA, worktreeId: 'w-1' }
const worktreeTargetA2: FilesTarget = { kind: 'worktree', machine: machineA, worktreeId: 'w-2' }
const worktreeTargetB: FilesTarget = { kind: 'worktree', machine: machineB, worktreeId: 'w-1' }
const sshTargetX: FilesTarget = { kind: 'ssh', connectionId: 'ssh-x' }
const sshTargetY: FilesTarget = { kind: 'ssh', connectionId: 'ssh-y' }

check('worktree target id dispatches on machine id + worktree id (qk.worktreeFilesRoot)', () => {
  assertEqual(ripgrepInstallTargetId(worktreeTargetA), 'machines:m-aaa:worktrees:w-1:files', 'worktree id')
})

check('ssh target id dispatches on connection id (qk.sshFilesRoot), distinct shape from worktree', () => {
  assertEqual(ripgrepInstallTargetId(sshTargetX), 'ssh:ssh-x:files', 'ssh id')
})

check('different worktrees on the same machine get different ids', () => {
  assertEqual(ripgrepInstallTargetId(worktreeTargetA) === ripgrepInstallTargetId(worktreeTargetA2), false, 'distinct worktree ids')
})

check('same worktree id on different machines gets different ids (machine id, not just worktree id, matters)', () => {
  assertEqual(ripgrepInstallTargetId(worktreeTargetA) === ripgrepInstallTargetId(worktreeTargetB), false, 'distinct machine ids')
})

check('two ssh targets get different ids', () => {
  assertEqual(ripgrepInstallTargetId(sshTargetX) === ripgrepInstallTargetId(sshTargetY), false, 'distinct ssh ids')
})

check('a target is not dismissed until dismissRipgrepInstall is called for it', () => {
  assertEqual(isRipgrepInstallDismissed(worktreeTargetA), false, 'not yet dismissed')
})

check('dismissRipgrepInstall marks exactly its own target dismissed, no others', () => {
  dismissRipgrepInstall(worktreeTargetA)
  assertEqual(isRipgrepInstallDismissed(worktreeTargetA), true, 'dismissed target')
  assertEqual(isRipgrepInstallDismissed(worktreeTargetA2), false, 'sibling worktree unaffected')
  assertEqual(isRipgrepInstallDismissed(worktreeTargetB), false, 'sibling machine unaffected')
  assertEqual(isRipgrepInstallDismissed(sshTargetX), false, 'unrelated ssh target unaffected')
})

check('dismissing a second target preserves the first dismissal (persisted set accumulates, not replaces)', () => {
  dismissRipgrepInstall(sshTargetX)
  assertEqual(isRipgrepInstallDismissed(worktreeTargetA), true, 'first dismissal still holds')
  assertEqual(isRipgrepInstallDismissed(sshTargetX), true, 'second dismissal took')
  assertEqual(isRipgrepInstallDismissed(sshTargetY), false, 'still-undismissed target unaffected')
})

console.log(`\n${passed} tests passed`)
