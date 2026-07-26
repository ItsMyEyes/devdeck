// Pure draft state + validation for the inline "add a new jump host" mini-form
// in SSHConnectionDialog.tsx (design:
// docs/superpowers/specs/2026-07-26-ssh-jump-host-manual-add-design.md).
// Kept separate from the component so the validation/request-building logic
// is testable without a component-test harness (this repo has none for .tsx).

import type { CreateSSHConnectionBody } from '@/lib/api'

export interface JumpHostDraft {
  host: string
  port: string
  username: string
  authType: 'password' | 'privatekey'
  password: string
  privateKey: string
  privateKeyPath: string
  passphrase: string
}

export function defaultJumpHostDraft(): JumpHostDraft {
  return {
    host: '',
    port: '22',
    username: '',
    authType: 'password',
    password: '',
    privateKey: '',
    privateKeyPath: '',
    passphrase: '',
  }
}

/** Mirrors SSHConnectionDialog's own canSubmit shape (host/username/port/secret) —
 *  a jump host created here is always brand new, so there's no "isEdit" allowance. */
export function isJumpHostDraftValid(draft: JumpHostDraft): boolean {
  const port = Number.parseInt(draft.port, 10)
  const portOK = Number.isInteger(port) && port >= 1 && port <= 65535
  const secretOK = draft.authType === 'password' ? draft.password.length > 0 : Boolean(draft.privateKey || draft.privateKeyPath)
  return draft.host.trim().length > 0 && draft.username.trim().length > 0 && portOK && secretOK
}

/** Builds the create-connection request body for a manually-added jump host:
 *  name auto-set to the host (ssh_connections.name has no uniqueness constraint),
 *  ungrouped, no executor (unused by sshmgr.Dialer on intermediate hops per
 *  dialer.go:7-8) and no jump chain of its own (kept to one hop at creation). */
export function buildJumpHostRequest(draft: JumpHostDraft): CreateSSHConnectionBody {
  const body: CreateSSHConnectionBody = {
    name: draft.host.trim(),
    group: '',
    host: draft.host.trim(),
    port: Number.parseInt(draft.port, 10),
    username: draft.username.trim(),
    authType: draft.authType,
    executorMachineId: null,
    jumpConnectionId: null,
  }
  if (draft.authType === 'password') {
    body.password = draft.password
  } else if (draft.privateKey) {
    body.privateKey = draft.privateKey
  } else if (draft.privateKeyPath) {
    body.privateKeyPath = draft.privateKeyPath
  }
  if (draft.authType === 'privatekey' && draft.passphrase) {
    body.passphrase = draft.passphrase
  }
  return body
}
