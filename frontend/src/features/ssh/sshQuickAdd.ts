// Draft state, validation, and request-chain building for creating an SSH
// connection (plus any jump hops it needs) from a single pasted ssh command.
// Design: docs/superpowers/specs/2026-07-30-ssh-new-tab-quick-add-design.md.
// Kept out of the components so it is testable without a component-test
// harness, exactly like jumpHostDraft.ts.

import type { CreateSSHConnectionBody } from '@/lib/api'
import type { SSHConnection } from '@/store/types'
import type { SSHAuthFieldsValue } from './SSHAuthFields'
import type { ParsedSSHCommand, ParsedSSHHop } from './sshCommand'

export interface SSHQuickAddDraft {
  /** The raw ssh command as typed. */
  raw: string
  name: string
  /** Set once the user edits the Name field themselves; until then every
   *  keystroke in the command re-derives the name. */
  nameTouched: boolean
  /** '' means "hub decides" — sent as null. */
  executorMachineId: string
  auth: SSHAuthFieldsValue
  /** When false, every created hop reuses `auth`. */
  jumpAuthOverride: boolean
  jumpAuth: SSHAuthFieldsValue
}

export type QuickAddStep =
  | { kind: 'existing'; id: string }
  | { kind: 'create'; body: CreateSSHConnectionBody }

export interface QuickAddPlan {
  /** Farthest hop first, target last, so each step's `jumpConnectionId` is
   *  the id produced by the step before it. */
  steps: QuickAddStep[]
}

export function defaultSSHAuthDraft(): SSHAuthFieldsValue {
  return { authType: 'password', password: '', privateKey: '', privateKeyPath: '', passphrase: '' }
}

export function defaultSSHQuickAddDraft(): SSHQuickAddDraft {
  return {
    raw: '',
    name: '',
    nameTouched: false,
    executorMachineId: '',
    auth: defaultSSHAuthDraft(),
    jumpAuthOverride: false,
    jumpAuth: defaultSSHAuthDraft(),
  }
}

function hopName(hop: ParsedSSHHop): string {
  return hop.user ? `${hop.user}@${hop.host}` : hop.host
}

export function deriveSSHQuickAddName(parsed: ParsedSSHCommand): string {
  return hopName(parsed.target)
}

/** Maps `-i path` onto the private-key auth fields. A path and a pasted key
 *  are mutually exclusive in `buildSSHQuickAddPlan`, so the stale pasted key
 *  is cleared rather than left to silently win. */
export function applyIdentityFile(draft: SSHQuickAddDraft, parsed: ParsedSSHCommand): SSHQuickAddDraft {
  if (!parsed.identityFile) return draft
  return {
    ...draft,
    auth: { ...draft.auth, authType: 'privatekey', privateKey: '', privateKeyPath: parsed.identityFile },
  }
}

export function findExistingConnection(hop: ParsedSSHHop, existing: SSHConnection[]): SSHConnection | undefined {
  return existing.find(
    (c) => c.host.toLowerCase() === hop.host.toLowerCase() && c.port === hop.port && c.username === hop.user,
  )
}

function isPortValid(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** Mirrors isJumpHostDraftValid's secret rule: a password, or a key by paste
 *  or by path. */
function isAuthValid(auth: SSHAuthFieldsValue): boolean {
  return auth.authType === 'password' ? auth.password.length > 0 : Boolean(auth.privateKey || auth.privateKeyPath)
}

export function isSSHQuickAddValid(
  parsed: ParsedSSHCommand | null,
  draft: SSHQuickAddDraft,
  existing: SSHConnection[],
): boolean {
  if (!parsed) return false
  if (!parsed.target.user.trim() || !parsed.target.host.trim() || !isPortValid(parsed.target.port)) return false
  if (parsed.jumps.some((hop) => !hop.user.trim() || !isPortValid(hop.port))) return false
  if (!draft.name.trim()) return false
  if (!isAuthValid(draft.auth)) return false
  // Jump credentials only matter if a hop is actually going to be created.
  const createsHop = parsed.jumps.some((hop) => !findExistingConnection(hop, existing))
  if (createsHop && draft.jumpAuthOverride && !isAuthValid(draft.jumpAuth)) return false
  return true
}

/** Emits the secret fields exactly like buildJumpHostRequest: never a blank
 *  string, and a pasted key beats a path. */
function applyAuth(body: CreateSSHConnectionBody, auth: SSHAuthFieldsValue) {
  if (auth.authType === 'password') {
    body.password = auth.password
    return
  }
  if (auth.privateKey) body.privateKey = auth.privateKey
  else if (auth.privateKeyPath) body.privateKeyPath = auth.privateKeyPath
  if (auth.passphrase) body.passphrase = auth.passphrase
}

export function buildSSHQuickAddPlan(
  parsed: ParsedSSHCommand,
  draft: SSHQuickAddDraft,
  existing: SSHConnection[],
): QuickAddPlan {
  const hopAuth = draft.jumpAuthOverride ? draft.jumpAuth : draft.auth
  const steps: QuickAddStep[] = []

  // `jumps` is nearest-first; the rows must be created farthest-first so each
  // one can point at the row before it.
  for (const hop of [...parsed.jumps].reverse()) {
    const match = findExistingConnection(hop, existing)
    if (match) {
      steps.push({ kind: 'existing', id: match.id })
      continue
    }
    const body: CreateSSHConnectionBody = {
      name: hopName(hop),
      group: '',
      host: hop.host,
      port: hop.port,
      username: hop.user,
      authType: hopAuth.authType,
      // sshmgr.Dialer runs every hop of a chain from the hub regardless of
      // this field, so an executor on an intermediate hop would do nothing.
      executorMachineId: null,
      jumpConnectionId: null,
    }
    applyAuth(body, hopAuth)
    steps.push({ kind: 'create', body })
  }

  // The target is always created, never reuse-matched: the user explicitly
  // asked for a new host and supplied a name and credentials for it.
  const target: CreateSSHConnectionBody = {
    name: draft.name.trim(),
    group: '',
    host: parsed.target.host,
    port: parsed.target.port,
    username: parsed.target.user,
    authType: draft.auth.authType,
    executorMachineId: draft.executorMachineId || null,
    jumpConnectionId: null,
  }
  applyAuth(target, draft.auth)
  steps.push({ kind: 'create', body: target })

  return { steps }
}
