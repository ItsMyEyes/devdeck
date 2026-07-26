# SSH jump host: create one inline from "Connect via"

## Problem

`SSHConnectionDialog`'s "Connect via" step (`jumpOptions`,
`SSHConnectionDialog.tsx:131-134`) only offers "Direct connection" plus
whatever `SSHConnection`s already exist. On a fresh install (0 saved hosts,
as in the reported screenshot) there is nothing else to pick — the dropdown
isn't broken, it's just empty by construction. There is no way to add a
bastion/jump host without leaving the dialog, saving it as a full connection
first, then reopening the target connection to select it.

## Decisions

- **Scope: SSH dialog only.** `DBConnectionDialog.tsx` has an identical
  tunnel-connection selector sourced from the same `SSHConnection` list and
  would benefit from the same treatment, but is a separate component with its
  own state — left as a follow-up, not part of this change.
- **No backend changes.** Creating a jump host reuses
  `POST /api/ssh/connections` verbatim — it's just another `SSHConnection`.
  Chaining (`JumpConnectionID`) and cycle validation already ship
  (`sshmgr.Dialer`, `SSHHandler.validateJumpChain`).
- **Add a sentinel option, not a separate button.** `jumpOptions` gets one
  new entry above the real connections: `{ value: '__new__', label: '+ Add
  new jump host…' }`. Picking it does **not** write to
  `dialog.jumpConnectionId` — it only flips a local `addingJump` boolean and
  reveals an inline mini-form below the select. Canceling the mini-form just
  hides it again; since `dialog.jumpConnectionId` was never touched, the
  select reverts to whatever it showed before (Direct, by default).
- **Minimal mini-form fields: Host, Port, Username, Auth.** No Name (auto-set
  to the trimmed host string — `ssh_connections.name` has no uniqueness
  constraint, so collisions are harmless), no Group (left `''`, falls into
  "Ungrouped"), no Executor machine, no nested jump chaining of its own.
  `sshmgr.Dialer.dial` always executes every hop of a chain from the hub
  process regardless of `ExecutorMachineID` (`dialer.go:7-8`, still
  unimplemented past phase 1), so an executor picker on an intermediate hop
  would be a control that does nothing yet.
- **Auth gets full parity with the main form**, not a stripped-down variant:
  password or private key, with file-select / generate / passphrase for the
  latter. Bastions are commonly key-only; a password-only quick-add would
  just push the user back to the slow path for the common case.
- **Created immediately, not deferred to the outer submit.** The mini-form
  has its own Create/Cancel buttons. Create calls `useCreateSSHConnection()`
  directly; on success it sets `dialog.jumpConnectionId` to the new
  connection's id, collapses the mini-form, and toasts. The new host is a
  real, independent `SSHConnection` from that point on — canceling or closing
  the outer "Add SSH connection" dialog afterward does not delete it.
  `useCreateSSHConnection` already invalidates the `sshConnections` query, so
  the new host appears in the main SSH list and in every future "Connect via"
  / DB "SSH tunnel" dropdown for free — this is the "auto add to list" part
  of the request.

## Changes

### 1. Extract `frontend/src/features/ssh/SSHAuthFields.tsx`

The main dialog's private-key block (current lines ~300-375: auth-type
select, password input, file input + Select-key/Generate buttons, key
textarea, generated-public-key display, passphrase input) is needed a second
time for the jump-host mini-form. Duplicating ~80 lines of key-generation
logic (PEM encoding, RSA JWK → `ssh-rsa` public key, passphrase-protected
key parsing) across two forms risks the two copies drifting. Extract it
instead:

- Props: `authType`, `password`, `privateKey`, `privateKeyPath`,
  `passphrase`, `onChange(patch)`, `disabled?`, `isEdit?` (controls the
  "unchanged" placeholder text shown on edit).
- Owns its own `privateKeyInputRef` and `generatedPublicKey` display state
  internally — that's presentation-only derived state, not needed by either
  caller.
- The pure helper functions currently at the top of `SSHConnectionDialog.tsx`
  (`arrayBufferToBase64`, `pemBlock`, `base64UrlToBytes`, `uint32Bytes`,
  `concatBytes`, `sshString`, `sshMpint`, `bytesToBase64`,
  `sshRsaPublicKey`) move into this file, since they exist only to serve it.
- `SSHConnectionDialog.tsx`'s own auth section becomes
  `<SSHAuthFields authType={dialog.authType} ... onChange={(p) =>
  setDialog(p)} disabled={busy} isEdit={isEdit} />` — behavior-preserving,
  same fields, same store.

### 2. `frontend/src/features/ssh/SSHConnectionDialog.tsx`

- `jumpOptions`: prepend the `__new__` sentinel option (constant
  `ADD_NEW_JUMP`).
- New local state (plain `useState`, matching this file's existing pattern
  for `generatedPublicKey` — transient, dialog-scoped draft data, not
  zustand):
  - `addingJump: boolean`
  - `jumpDraft: { host, port, username, authType, password, privateKey,
    privateKeyPath, passphrase }` (same shape as the relevant slice of
    `SSHDialogState`, defaults mirroring `openAddSSHConnection`'s: port
    `'22'`, authType `'password'`).
  - Both reset (`addingJump` → `false`) whenever `dialog.open` transitions to
    `false`, via a `useEffect` keyed on `dialog.open` — otherwise reopening
    the drawer for a different connection could show a stale mini-form.
- The "Connect via" `<Select>`'s `value` becomes
  `addingJump ? ADD_NEW_JUMP : dialog.jumpConnectionId`; `onValueChange`
  branches: picking `ADD_NEW_JUMP` resets `jumpDraft` to defaults and sets
  `addingJump = true` without touching `dialog.jumpConnectionId`; picking
  anything else sets `addingJump = false` and
  `setDialog({ jumpConnectionId: v })` as today.
- When `addingJump` is true, render the inline mini-form in place of the
  existing "direct/via jump host" hint paragraph: Host/Port/Username
  `<Input>`s, `<SSHAuthFields>` bound to `jumpDraft`, and a `Cancel` /
  `Create` button row.
  - Validation mirrors the outer form's `canSubmit` shape: `jumpPortOK`
    (1-65535), `jumpSecretOK` (password non-empty, or privateKey/Path
    present), `host`/`username` non-empty trimmed → gates the `Create`
    button (also disabled while `busy`, reusing the existing
    `createConnection.isPending` flag so the whole dialog locks the same way
    it already does during the outer submit).
  - `Create` builds a `CreateSSHConnectionBody` (`name`/`host` = trimmed
    host, `group: ''`, `executorMachineId: null`, `jumpConnectionId: null`,
    `authType`, port parsed) plus the secret fields, and calls
    `createConnection.mutate(...)` (the same `useCreateSSHConnection()`
    instance already used by the outer `submit()` — mutually exclusive in
    time, so sharing it is fine and keeps `busy` accurate).
    - `onSuccess`: `setDialog({ jumpConnectionId: created.id })`,
      `setAddingJump(false)`, `showToast('Added jump host "…"')`.
    - `onError`: `showToast(message)`, mini-form stays open with the
      entered values intact so the user can fix and retry.
  - `Cancel`: `setAddingJump(false)`. No API call, no state left behind.

## Error handling

- No host-reachability check at creation time — matches existing behavior
  for every `SSHConnection` (TOFU host-key pinning happens on first real
  connect, not on save).
- Create failures (validation 400s from `PostConnection`, network errors)
  surface via the existing `showToast` path already used by the outer
  form's `onError`; nothing new needed server-side.

## Testing

- No component-test harness exists for `.tsx` files in this repo (only
  plain-logic `.test.ts` files, e.g. `ripgrepInstallPrefs.test.ts`) — no new
  convention introduced here.
- Verify via `npm run typecheck` and manual exercise in the browser: add a
  first host with a manually-created password-auth jump host, then a second
  with a manually-created private-key jump host (file + generate paths),
  confirm both appear in the main SSH list afterward and are selectable as
  jump hosts for further connections.

## Out of scope

- `DBConnectionDialog.tsx`'s SSH-tunnel selector (noted above as a
  follow-up).
- Nested chaining UI (creating a jump host that itself jumps through
  another) — the existing chain-depth/cycle validation in
  `SSHHandler.validateJumpChain` already supports this once the user edits
  the new connection from the main list; no new UI for it here.
- Executor-machine selection for jump hosts (unused by `sshmgr.Dialer` until
  a later phase, per `dialer.go:7-8`).
