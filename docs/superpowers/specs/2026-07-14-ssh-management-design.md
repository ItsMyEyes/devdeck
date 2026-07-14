# SSH Management (shell, SFTP, port forwarding) — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorming complete)

## Goal

Add a Termius-like SSH manager to Loom: saved connections to *any* SSH host
(not limited to registered Loom Machines), an interactive shell, SFTP
(browse/CRUD + upload/download), port forwarding (`-L`/`-R`/`-D`), and
jump-host/bastion chaining. One coherent architecture is designed here up
front so the connection model and secret storage don't need reworking once
SFTP/forwarding are added later; the implementation itself is phased (see
"Build order" below).

This is a new, orthogonal subsystem — not an extension of the existing
`Machine` concept. Today a `Machine` means an already-running Loom *runtime*
process, trusted via a shared bearer key (`backend/internal/domain/models.go:194-207`).
An `SSHConnection` means an arbitrary external host reached over SSH with its
own credentials. The two concepts intersect only at "which Machine executes
this SSH connection" (see Execution & routing).

## Decisions (from brainstorming)

1. **Execution: either the hub-adjacent runtime or the operator's local Tauri
   sidecar, chosen per connection.** The Tauri desktop app already bundles the
   full Go backend as a sidecar (`docs/superpowers/specs/2026-07-13-tauri-desktop-sidecar-design.md`),
   itself registered as a Machine (`IsLocal: true`). So "choosing an executor"
   is just picking a Machine from the existing registry — no separate Rust SSH
   implementation is needed anywhere.
2. **Credentials: hybrid storage.** Secrets default to an encrypted blob in
   the backend DB; per-secret, the operator can instead push it to the OS
   keychain from the Tauri app, which locks that connection's executor to the
   specific local machine that owns the keychain entry.
3. **Port forwarding: all three modes for v1** — local (`-L`), remote
   (`-R`), and dynamic/SOCKS (`-D`).
4. **Auth methods: password, private key (+ optional passphrase), and
   jump-host/bastion chaining**, all in v1.
5. **UI surface: a new pane/tile kind in the workspace canvas** (alongside the
   existing Terminal pane and Browser tile), not a standalone page separate
   from the tiling workspace. Connection *management* (CRUD of saved hosts)
   still gets its own settings-style page, matching the existing `Machines`
   page pattern.
6. **Connection scope: global to the operator**, not per-workspace — matches
   the existing `Machine` registry, which also has no workspace scoping
   (`port/store.go:80-84`).
7. **Host key verification: TOFU** (trust-on-first-use), like `known_hosts`.
   First successful connect pins the host's key fingerprint; later mismatches
   hard-block with an explicit "host key changed — accept new key?"
   confirmation.
8. **Architecture: new `internal/sshmgr` package**, sibling to
   `internal/terminal`, rather than folding SSH shells into the existing PTY
   session registry or building port forwarding on top of `internal/netproxy`.
   See "Approaches considered" for why.

## Approaches considered

**Fold SSH shell into the existing `terminal.Session`/registry** (reattach,
ring buffer, grace TTL reuse) was considered and rejected: `registry.go`
calls concrete `go-pty` methods directly (e.g. `ptmx.Resize(cols, rows)`),
not through an interface, and `ssh.Session`'s API doesn't shape-match. Forcing
the fit would require interface surgery on a file `CLAUDE.md` already flags as
a serialization point, for uncertain payoff.

**Build port forwarding on `internal/netproxy`** (existing SOCKS5/HTTP forward
proxy) was considered and rejected as the primary mechanism: `netproxy` today
is a static, process-wide, CLI-flag-activated proxy (`--socks5-addr` at
startup), not a per-connection, dynamically-toggled-from-the-UI rule.
Retrofitting dynamic activation would likely cost more than it saves. (Its
SOCKS5 *protocol codec* may still be worth reusing during implementation —
noted below, not a design commitment.)

## Data model

New domain types, sibling to `Machine`/`Project`, global (no `WorkspaceID`):

```go
type SSHConnection struct {
    ID                 string
    Name               string
    Host               string
    Port               int
    Username           string
    AuthType           string  // "password" | "privatekey"
    JumpConnectionID   *string // chains to another SSHConnection for bastion hops
    ExecutorMachineID  *string // which Machine dials this host; nil = hub decides
    HostKeyFingerprint *string // TOFU-pinned on first successful connect
}

type SSHSecret struct {
    ConnectionID string
    Kind         string  // "password" | "privatekey" | "passphrase"
    StorageKind  string  // "db" | "keychain"
    CipherText   []byte  // set when StorageKind == "db" (AES-256-GCM, server-side master key)
    KeychainRef  *string // set when StorageKind == "keychain" (Tauri OS keychain lookup key)
}
```

`port.Store` gains `SSHConnections/CreateSSHConnection/UpdateSSHConnection/
DeleteSSHConnection/SSHConnectionByID` plus secret accessors, following the
same CRUD shape already used for `Machine`.

**Consistency rule:** if any secret on a connection has `StorageKind:
"keychain"`, that connection's `ExecutorMachineID` is locked to the specific
local (`IsLocal`) machine that owns the keychain entry — only that machine
can retrieve the secret, so no other runtime could execute the session
anyway. The UI must enforce this (disable changing the executor once a
keychain secret exists) and the backend must reject a mismatched executor at
session-creation time.

## Execution & routing

No new routing concept: reuses the existing Machine registry and
direct-first/hub-proxy resolution (`machineClient`) already used for
worktrees and terminals. `ExecutorMachineID` selects which runtime process —
a hub-adjacent runtime, or a Tauri desktop's local sidecar (itself just
another Machine) — dials the SSH host.

Practical guidance (not enforced in code): a port-forwarding listener is only
reachable from wherever it's opened, so forwarding rules the operator intends
to use with their own local tools should target their own desktop's local
Machine as executor.

## Interactive shell

New `internal/sshmgr` package. A shell `SSHSession` streams over a new WS
route (`/api/ssh/sessions/{id}/ws`) mirroring the existing PTY WS frame
protocol in `internal/terminal` (stdin/stdout frames, resize), so the
frontend's xterm.js wiring is reused almost as-is. Backed by
`golang.org/x/crypto/ssh`'s `Session.RequestPty`/`WindowChange`/
`StdinPipe`/`StdoutPipe` instead of `go-pty`.

## SFTP

REST endpoints under `/api/ssh/connections/{id}/sftp/...` (list, mkdir,
rename, delete, stat), mirroring the shape of the existing worktree fs-browse
endpoints, backed by `pkg/sftp.Client`. Upload/download are streamed HTTP
bodies (multipart POST / streamed GET), routed through whichever Machine is
the connection's executor — consistent with how `machineApi.ts` already does
direct-first-then-hub-proxy for fs-browse calls.

## Port forwarding

Each forwarding rule is a headless `SSHSession` (kind `forward-local` /
`forward-remote` / `forward-dynamic`), started/stopped independently of any
shell/SFTP session on the same connection:

- **`-L` (local forward):** executor opens a local `net.Listener`, pipes
  accepted connections through `ssh.Client.Dial` to the remote target.
- **`-R` (remote forward):** executor calls `ssh.Client.Listen` on the remote
  side, pipes back to a local target reachable from the executor.
- **`-D` (dynamic/SOCKS):** executor runs a minimal SOCKS5 server, dialing
  each proxied connection through `ssh.Client.Dial`. Implementation note:
  `internal/netproxy/socks5.go`'s SOCKS5 protocol codec may be reusable here
  even though its activation model isn't a fit — worth checking during
  implementation.

## Jump-host / bastion chaining

`JumpConnectionID` resolves recursively at connect time: the executor dials
the jump connection first, then uses that `ssh.Client`'s `Dial` to reach the
next hop's `host:port` and performs the SSH handshake on top of that proxied
connection (standard nested-client pattern). Chains longer than one hop work
for free since resolution just follows pointers — not restricted to a single
hop.

## Credential storage

Hybrid: secrets default to an encrypted blob in the backend DB
(AES-256-GCM, server-side master key from env, never returned to
clients — unlike `Machine.Key`, which is deliberately shared with clients for
direct-first connections). Per-secret, the operator can instead push it to
the OS keychain from the Tauri app (secret never touches the DB), which
triggers the executor-locking rule above.

## Host key verification

TOFU: `HostKeyFingerprint` is empty on connection creation. The first
successful connect stores whatever key the host presents. Subsequent
connects compare against the stored fingerprint and hard-block on mismatch,
requiring an explicit "host key changed, possible MITM — accept new key?"
confirmation before proceeding.

## Frontend / UI

- `frontend/src/features/ssh/` — `SSHConnectionsModule.tsx` +
  `SSHConnectionDialog.tsx`, following the existing `machines` feature's
  list+dialog pattern (host/port/user/auth/jump-host/executor-machine/
  forwarding-rules fields).
- New route `w.$wsId.ssh.tsx` for the connection-manager page.
- New tile kinds in the workspace canvas: `ssh-shell` (new
  `SSHShellPane.tsx`, reusing `PaneCanvas`/`ExpandedTerminal`'s xterm.js
  wiring against the new WS route) and `ssh-sftp` (file browser — during
  implementation planning, confirm and adapt whatever component already
  renders the worktree file browser rather than building a new one).
- Forwarding rules are managed inline in the connection dialog/list
  (start/stop toggle + listen-address indicator), not a pane, since they're
  headless.

## Error handling

REST errors follow the mandatory `{"error":"message"}` envelope
(`handleStoreErr`-style — never raw SQL/library errors). WS shell sessions
surface connect/auth/host-key failures as an error frame the frontend renders
in the pane before the session opens, matching how PTY spawn failures already
surface today.

## Testing

- **Go:** table-driven unit tests for `sshmgr` connection resolution
  (jump-chain recursion, executor-locking rule) and secret encryption
  round-trip, plus an in-process SSH server
  (`golang.org/x/crypto/ssh` server mode — the standard way to test this
  library without a real network host) for shell/SFTP/forwarding integration
  tests.
- **Frontend:** follow the existing test conventions used for the `machines`
  feature (CRUD dialog) and `terminal` feature (pane wiring, e.g.
  `paneTree.test.ts`).

## Build order (for the implementation plan)

1. Connections CRUD + secrets model + interactive shell (password/key auth,
   TOFU host keys).
2. SFTP browse/CRUD/transfers.
3. Port forwarding (`-L`/`-R`/`-D`) + jump-host chaining.
