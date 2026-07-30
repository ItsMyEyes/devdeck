# SSH from "New tab", and one-line host creation from an `ssh` command

## Problem

Two gaps, one root cause.

**The tab strip's "+" can't open an SSH shell.** `NewTabDialog.tsx` offers
exactly two kinds — Browser and Spawn shell (`newTab.kind`, `useDevDeckStore.ts:50`).
The `ssh-shell` tile kind already exists (`tileTree.ts:18,85-90`) and is
opened by `openSSHShellTab(wsId, connectionId)`, but its only entry point is
the Connect button on a `HostCard` in the SSH Connections page
(`SSHConnectionsModule.tsx:112-116`). Opening a remote shell therefore means
leaving the workspace, finding the host, connecting, and being navigated
back.

**Adding a host is field-by-field.** `SSHConnectionDialog` asks for Name,
Group, Host, Port, Username, auth, executor and jump separately — even
though the user almost always already has the whole thing in one string they
copied from a runbook or their shell history:

```
ssh root@10.1.1.1 -J root@2131
```

Every field in that string is one the dialog asks for individually.

## Decisions

- **No backend changes.** `POST /api/ssh/connections` already accepts
  everything needed, including `jumpConnectionId` chaining. The parser and
  the request-chain builder are entirely frontend.

- **Hosts created this way are saved to the registry**, not ephemeral. The
  backend needs a real `ssh_connections` row to dial at all, and
  `useCreateSSHConnection` already invalidates the `sshConnections` query, so
  a host quick-added from a tab immediately shows up in the SSH Connections
  page and in every future "Connect via" / DB tunnel dropdown. An ephemeral
  variant would need a new lifecycle server-side and would leak rows on
  crash.

- **Credentials are still mandatory.** `PostSSHConnection` rejects a body
  without a password or key (`handler/ssh.go:180-197`), and there is no agent
  auth. So the connection string alone can never be enough — the quick-add
  form always carries an auth block. The one exception is `-i`: an identity
  file maps straight onto the existing `privateKeyPath` field, so
  `ssh -i ~/.ssh/id_rsa root@host` really is a single line with nothing else
  to fill in.

- **A jump host reuses the target's credentials by default.** The common
  shape is `root@` everywhere with the same key. An `jumpAuthOverride`
  toggle reveals a separate auth block when they differ. Asking twice
  unconditionally would undo the point of the feature.

- **Existing hosts are reused, not duplicated.** Before creating a hop, the
  builder looks for a saved connection with the same `host` (case-insensitive),
  `port` and `username`. `ssh_connections.name` has no uniqueness constraint
  so duplicates are harmless, but silently accumulating a new `root@bastion`
  row per connect is noise.

- **Name is auto-derived and editable.** Prefilled `user@host`, matching
  `buildJumpHostRequest`'s existing auto-naming, but shown as a real field so
  the SSH Connections list stays curatable from here.

- **Unknown flags are ignored, not fatal.** Pasted commands routinely carry
  `-A`, `-o StrictHostKeyChecking=no`, `-L …` — none of which map onto the
  `SSHConnection` model. Rejecting the whole string over them would make
  paste-from-runbook fail for reasons the user can't act on. They are
  collected and surfaced as a small "diabaikan: …" note instead, so nothing
  disappears silently.

- **The two surfaces share the parser, not the flow.** The New tab quick-add
  *creates* rows (so it drives the full multi-hop chain programmatically).
  The Add-connection drawer only *fills fields* in a form the user still
  reviews and submits. Same `parseSSHCommand`, different consumers.

## Changes

### 1. `frontend/src/features/ssh/sshCommand.ts` (new)

Pure, no React, no imports from the app — testable with `npx tsx`.

```ts
export interface ParsedSSHHop {
  /** May be empty — the target's username is required by the backend, so an
   *  empty one blocks submit rather than failing the parse. */
  user: string
  host: string
  port: number
}

export interface ParsedSSHCommand {
  target: ParsedSSHHop
  /** In `-J` order: nearest hop first, matching ssh(1)'s own semantics. */
  jumps: ParsedSSHHop[]
  /** `-i` path, passed through verbatim as `privateKeyPath` — it is resolved
   *  on the executor machine, not here, so `~` is left alone. */
  identityFile: string | null
  /** Recognised-but-unmapped flags, for the "diabaikan: …" note. */
  ignoredFlags: string[]
}

export function parseSSHCommand(raw: string): ParsedSSHCommand | null
```

Behaviour:

- A leading `ssh` token is optional — `root@10.1.1.1` alone parses.
- Tokenised on whitespace with basic single/double-quote grouping, so
  `-i "/path/with space/key"` survives.
- Read: `[user@]host[:port]` (the `:port` form isn't real ssh syntax but is
  commonly pasted, so it's accepted), `-p N`, `-l user`, `-i path`,
  `-J spec[,spec…]`. Both `-pN` and `-p N` spellings.
- `-o Key=Val` consumes two tokens; other unrecognised flags consume one.
  Both land in `ignoredFlags`.
- A hop with no user inherits the target's user; a hop with no port gets 22.
- Returns `null` only when there is no host token at all.

### 2. `frontend/src/features/ssh/sshQuickAdd.ts` (new)

Draft state and request-chain building, again pure.

```ts
export interface SSHAuthDraft {
  authType: 'password' | 'privatekey'
  password: string
  privateKey: string
  privateKeyPath: string
  passphrase: string
}

export interface SSHQuickAddDraft {
  raw: string
  name: string
  /** '' means "hub decides" (null on the wire). */
  executorMachineId: string
  auth: SSHAuthDraft
  jumpAuthOverride: boolean
  jumpAuth: SSHAuthDraft
}

export type QuickAddStep =
  | { kind: 'existing'; id: string }
  | { kind: 'create'; body: CreateSSHConnectionBody }

export interface QuickAddPlan {
  /** Farthest hop first, so each step's `jumpConnectionId` is the id of the
   *  step before it. The last entry is always the target host. */
  steps: QuickAddStep[]
}

export function defaultSSHQuickAddDraft(): SSHQuickAddDraft
export function deriveSSHQuickAddName(parsed: ParsedSSHCommand): string
export function applyIdentityFile(draft: SSHQuickAddDraft, parsed: ParsedSSHCommand): SSHQuickAddDraft
export function isSSHQuickAddValid(parsed: ParsedSSHCommand | null, draft: SSHQuickAddDraft): boolean
export function buildSSHQuickAddPlan(
  parsed: ParsedSSHCommand,
  draft: SSHQuickAddDraft,
  existing: SSHConnection[],
): QuickAddPlan
```

- `applyIdentityFile` is what turns `-i path` into
  `{ authType: 'privatekey', privateKeyPath: path }`; the dialog calls it on
  every successful parse so the auth block collapses to a one-line summary
  when a key was named.
- `isSSHQuickAddValid` mirrors `isJumpHostDraftValid`: non-empty target user,
  valid port, and a secret present for the chosen auth type — plus the same
  check against `jumpAuth` when `jumpAuthOverride` is on and at least one hop
  will actually be created.
- `buildSSHQuickAddPlan` emits `create` bodies with `jumpConnectionId: null`;
  the caller overwrites it with the previous step's resolved id. Hop bodies
  get `group: ''`, `executorMachineId: null` (`sshmgr.Dialer` runs every hop
  from the hub regardless — see the 2026-07-26 jump-host spec) and a name of
  `user@host`. Only the final target body carries the draft's `name` and
  `executorMachineId`.

### 3. `frontend/src/store/useDevDeckStore.ts`

- `NewTabKind` gains `'ssh'`.
- `NewTabState` gains `sshConnectionId: string` (`''` = nothing picked;
  `'__new__'` = the quick-add sentinel), reset by `openNewTab`.
- `setNewTab`'s patch type widens to include it.

### 4. `frontend/src/features/tabs/NewTabDialog.tsx`

- A third `KindTab` — **SSH** — beside Browser and Spawn shell.
- In SSH mode the body is a single **Host** `Select` whose first entry is the
  `__new__` sentinel `+ Host baru dari perintah ssh…`, followed by every
  saved connection. This is deliberately the same shape as
  `SSHConnectionDialog`'s `ADD_NEW_JUMP` option — "existing or new" stays one
  control rather than an extra mode switch.
- The existing Machine `Select` is reused in SSH mode as **Executor machine**
  with a `Hub decides` entry prepended and selected by default. It is hidden
  when a saved host is picked, since that connection already carries its own
  executor. Browser/Shell modes keep today's required-machine behaviour
  unchanged.
- Picking `__new__` reveals the quick-add block: the command input, a parse
  summary line (`root@10.1.1.1 · via root@2131 · :22`) plus the ignored-flag
  note, the Name field, and `SSHAuthFields` (reused as-is) — with the
  jump-credential toggle only rendered when the parse actually produced hops
  that aren't already saved.
- Submit:
  - saved host → `closeNewTab()`, `openSSHShellTab(wsId, id)`, navigate to
    `/w/$wsId`, mirroring `SSHConnectionsModule`'s `connect`.
  - `__new__` → run the plan's steps in order through
    `useCreateSSHConnection`, threading each result id into the next step's
    `jumpConnectionId`, then open the tab with the final id.
- Failure mid-chain shows a toast and leaves the dialog open with the input
  intact. Hops already created stay saved — on retry the reuse-match in
  `buildSSHQuickAddPlan` turns them into `existing` steps, so a retry doesn't
  duplicate them.

### 5. `frontend/src/features/ssh/SSHConnectionDialog.tsx`

A **Paste perintah ssh** `Input` at the top of the drawer body, rendered only
when `!isEdit` (an edit already has a host; silently rewriting it on paste
would be a trap).

On each successful parse it sets `dialog.host`, `port`, `username`, and
`name` (name only while it is still empty or still equal to the previously
derived one, so a hand-typed name is never clobbered), plus `authType` +
`privateKeyPath` when `-i` was present. Every field stays visible and
editable — this fills the form, it does not replace it.

For `-J`:

- nearest hop matches a saved connection → `dialog.jumpConnectionId` is set
  directly.
- no match → the existing inline jump mini-form is opened (`addingJump`) with
  `jumpDraft.host/username/port` prefilled, so only the secret is left to
  type.
- more than one hop → the nearest is prefilled as above and a one-line note
  says the outer hops must be created first. The inline form hard-codes
  `jumpConnectionId: null` (`jumpHostDraft.ts:46-56`) and can only produce a
  single hop; extending it to chains belongs with the quick-add path, not
  here.

### 6. Tests

`sshCommand.test.ts` and `sshQuickAdd.test.ts`, in the plain-assertion style
of `jumpHostDraft.test.ts` (this project has no Vitest/Jest), run with
`npx tsx`.

`sshCommand`: the spec's own example; bare `user@host`; `-p`/`-pN`/`-l`
combinations; `-i` with a quoted path; multi-hop comma `-J`; hop user/port
inheritance; `-o Key=Val` two-token skip; unknown-flag collection; `null` on
a hostless string.

`sshQuickAdd`: name derivation; identity-file application; validity gates
(missing user, bad port, missing secret, missing jump secret when overridden);
plan ordering farthest-hop-first; existing-host reuse by host/port/user with
case-insensitive host; executor and name landing only on the target body.

Then `npm run typecheck` and `npm run build`.

## Non-goals

No backend changes. No `ssh-agent`/agent auth (the backend has no such
`authType`). No `~/.ssh/config` Host-alias resolution. No `ProxyCommand`.
No port forwarding (`-L`/`-R`/`-D`) — parsed into `ignoredFlags` and dropped.
`DBConnectionDialog`'s tunnel selector is untouched, same as the 2026-07-26
spec left it.
