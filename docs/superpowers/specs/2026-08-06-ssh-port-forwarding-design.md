# SSH Port Forwarding (`-L` / `-R` / `-D`)

**Date:** 2026-08-06
**Status:** design approved, pending implementation plan
**Implements:** build-order phase 3 of
`docs/superpowers/specs/2026-07-14-ssh-management-design.md`, whose "Port
forwarding" section sketched the three modes but left lifecycle, storage and
failure behaviour open. This spec settles them.

## Problem

`internal/sshmgr` can open an interactive shell, run commands, and browse files
over SFTP for a saved connection. It cannot forward a port. The package doc
(`dialer.go:1-8`) has said "port forwarding in later phases" since phase 1.

So reaching a service that is only routable from a remote host — a database on a
private subnet, a Redis behind a bastion, a dev server on a runtime — means
leaving DevDeck and running `ssh -L` in a terminal, outside the connection
registry that already holds that host's credentials, host key, and jump chain.

## Goal

Saved forwarding rules per SSH connection, in all three modes, each with an
explicit start/stop toggle and a live status the UI can show. A dropped
connection recovers on its own.

## Non-goals

- **No autostart on boot.** A restart leaves every forward off until toggled.
  No listener reappears on a port you forgot about.
- No UNIX-socket forwards (`-L /path/to.sock:...`).
- No remote *dynamic* forwarding (`-R` with SOCKS) — rare, and recent-OpenSSH
  only.
- No per-forward traffic accounting.
- `CatalogSnapshot` is **not** modified — see "Rules vs. runtime" below.

## Rules vs. runtime

The two halves live in different places, deliberately:

**The hub owns the rules.** A new `ssh_forwards` table, foreign-keyed to
`ssh_connections` with `ON DELETE CASCADE`, mirroring how `ssh_secrets` already
hangs off a connection.

**The executor owns the live listeners**, in memory, keyed by rule id. Starting a
forward pushes the *whole rule* in the request body, so the executor never needs
a persisted copy of it.

That choice avoids syncing forwards through `CatalogSnapshot`. Two reasons:
`CatalogSnapshot` and the store interface around it are convergence surfaces the
project's orchestration rules single-thread, and routing rules through catalog
sync would create a "created a rule, can't start it yet" window while the
replica catches up — latency bought for no benefit, since the caller already
holds the rule it wants to start.

The cost is that an executor restart drops live forwards. Given the no-autostart
decision above, that is already the specified behaviour: they come back as
`off`, which is exactly what the UI would show anyway.

## Data model

```go
// SSHForward is one saved forwarding rule on an SSH connection.
type SSHForward struct {
    ID           string `json:"id"`
    ConnectionID string `json:"connectionId"`
    // Mode is "local" (-L), "remote" (-R) or "dynamic" (-D).
    Mode     string `json:"mode"`
    BindHost string `json:"bindHost"`
    BindPort int    `json:"bindPort"`
    // TargetHost/TargetPort are empty/zero for mode "dynamic", which has no
    // single target — each proxied connection carries its own.
    TargetHost string `json:"targetHost"`
    TargetPort int    `json:"targetPort"`
    Label      string `json:"label"`
}

// SSHForwardState is live, in-memory, never persisted.
type SSHForwardState struct {
    ForwardID string `json:"forwardId"`
    // Status is "off" | "starting" | "running" | "reconnecting" | "failed".
    Status    string `json:"status"`
    BoundAddr string `json:"boundAddr,omitempty"`
    Error     string `json:"error,omitempty"`
    Attempts  int    `json:"attempts"`
}
```

Both mirrored in `frontend/src/store/types.ts` per the domain-sync contract.

Store methods on `port.Store`, following the existing SSH-connection CRUD shape:
`SSHForwards(connectionID)`, `SSHForwardByID`, `CreateSSHForward`,
`UpdateSSHForward(id, port.SSHForwardPatch)`, `DeleteSSHForward`.

## The forwarder

New `backend/internal/sshmgr/forward.go`:

```go
type Forwarder struct { /* dialer + mutex + map[forwardID]*activeForward */ }

func NewForwarder(dialer *Dialer) *Forwarder
func (f *Forwarder) Start(rule domain.SSHForward) (domain.SSHForwardState, error)
func (f *Forwarder) Stop(forwardID string) error
func (f *Forwarder) States() []domain.SSHForwardState
```

### Dedicated client, not `FilePool`

`FilePool` reaps idle entries after `filePoolIdleTTL` (10 minutes). A tunnel
opened this morning that has carried no traffic since is *precisely* an idle
entry — pooling would silently tear down working forwards. Each active forward
therefore dials and holds its own `*ssh.Client` through `Dialer.Dial`, for as
long as it is on. It inherits jump-chain resolution, TOFU host-key pinning and
`ExecutorMachineID` routing for free, because all of that lives in `Dial`.

### Supervisor state machine

One goroutine per active forward:

```
off ──toggle──▶ starting ──ok──▶ running
                  │                 │
                  │ err             │ client dies
                  ▼                 ▼
                failed ◀─give up─ reconnecting
                                     │   ▲
                                     └───┘
                              backoff 1→2→4…≤30s

toggle off from ANY state ──▶ off (listener closed)
```

Backoff is exponential from 1s, capped at 30s. `reconnecting` is a distinct
status, not a flavour of off: a forward that is retrying still holds its slot
and its intent.

`failed` is terminal and requires an explicit re-toggle. Errors that will never
resolve by retrying — auth failure, `ErrHostKeyChanged`, a bind port already in
use, an invalid rule — go straight to `failed` rather than entering the backoff
loop. Transport-shaped errors go to `reconnecting`. Without that split, a
revoked key or a typo'd host would retry forever while the UI showed a hopeful
"reconnecting".

### Modes

| Mode | Listener | Per accepted connection |
|---|---|---|
| `local` (`-L`) | `net.Listen` on the executor | `client.Dial("tcp", target)` |
| `remote` (`-R`) | `client.Listen("tcp", bind)` on the remote host | `net.Dial(target)` from the executor |
| `dynamic` (`-D`) | `net.Listen` on the executor | SOCKS5 codec; each CONNECT dials via `client.Dial` |

## Changes to `internal/netproxy`

Two small changes, both enabling reuse instead of duplication:

1. **Export `relay` as `Relay`.** All three modes need exactly its half-close
   behaviour (`socks5.go:261-274`) — a one-directional EOF must not stall the
   other direction. Re-implementing that in `sshmgr` would be a second copy of
   subtle code that has already been gotten right once.

2. **Add an optional `DialContext` to `SOCKS5Server`**, defaulting to today's
   `net.Dialer` so every existing caller is unaffected. `-D` sets it to dial
   through `ssh.Client`. This is exactly the reuse the SSH management spec
   anticipated at its line 153 ("the SOCKS5 protocol codec may be reusable here
   even though its activation model isn't a fit") — the codec is reused; the
   activation model is not.

Note the boundary against `2026-08-06-published-socks5-design.md`: that spec's
`PublishedSOCKSService` owns a *direct-dial* listener lifecycle. `-D` shares the
codec with it and nothing else.

## API

Rule CRUD on the hub; lifecycle on the executor. Lifecycle routes register on
**every** role, since the executor is usually a runtime.

```
GET    /api/ssh/connections/{id}/forwards   → []SSHForward
POST   /api/ssh/connections/{id}/forwards   ← rule            → SSHForward
PATCH  /api/ssh/forwards/{id}               ← partial rule    → SSHForward
DELETE /api/ssh/forwards/{id}

POST   /api/ssh/forwards/start              ← full SSHForward → SSHForwardState
POST   /api/ssh/forwards/{id}/stop          → SSHForwardState
GET    /api/ssh/forwards/states             → []SSHForwardState
```

Deleting a rule stops its forward first if running. Editing a running rule stops
and restarts it, so the live listener always matches the saved rule.

## Validation

Enforced on write, and again at start (a rule can be edited between the two):

- `mode` ∈ {`local`, `remote`, `dynamic`}.
- `bindPort` in 1–65535. `targetHost`/`targetPort` required for `local` and
  `remote`, rejected for `dynamic`.
- `bindHost` defaults to `127.0.0.1`.

## Reachability warnings

A forward's listener is only reachable from wherever it is opened — the
executor. The connection's `ExecutorMachineID` therefore decides who can use the
tunnel, which the SSH management spec already flagged as practical guidance
(lines 119-122). The UI surfaces it rather than leaving it to be rediscovered:

- Binding `0.0.0.0` shows an inline warning that the forward becomes reachable
  by anything that can route to the executor.
- For `-R`, a non-loopback bind additionally requires `GatewayPorts yes` on the
  remote sshd. Without it the remote bind silently collapses to loopback and the
  forward *appears* to work while being unreachable — worth pre-empting in the
  UI, since nothing in the protocol reports it as an error.

## Error handling

All REST errors use the mandatory `{"error":"message"}` envelope.

| Condition | Behaviour |
|---|---|
| Local bind port in use | `failed` immediately with the bind error; no backoff loop. |
| Auth failure / host-key change / invalid rule | `failed` immediately, error surfaced verbatim in the state. |
| SSH transport dies | `reconnecting`, backoff, listener reopened on success. |
| Remote sshd refuses the remote bind (`-R`) | `failed` with the remote's reason. |
| Target unreachable on an accepted connection | That connection is closed; the forward stays `running`. One bad target must not tear down the tunnel. |
| Stop on an unknown/already-stopped id | Idempotent success. |
| Executor restart | All forwards return as `off` (no autostart). |

## Frontend

- **`features/ssh/SSHForwardsPanel.tsx`** — the rules table (mode, bind, target,
  status dot, toggle, edit, delete) plus an add row. Mounted in
  `SSHConnectionDialog` and inline in `SSHConnectionsModule`, per the SSH
  management spec's "managed inline, not a pane" decision — forwards are
  headless and have no pane content to show.
- **`features/data/queries.ts`** — `useSSHForwards(connectionId)` for rules, and
  `useSSHForwardStates()` polling at `refetchInterval: 2000` while visible.
  Mutations invalidate on success, and toast + invalidate on failure.
- Loading, error, and empty (no rules yet) states rendered explicitly.

## Testing

**Go**

- `sshmgr/testserver_test.go` already provides an in-process
  `golang.org/x/crypto/ssh` server. All three modes get real end-to-end tests
  through it: open the forward, write bytes at one end, assert they arrive at
  the other, stop, assert the port is closed.
- State machine with an injected clock: backoff sequence and cap; transport
  error → `reconnecting`; auth error → `failed` without retrying; toggle-off
  from every state.
- `Stop` is idempotent; a dead target closes one connection without killing the
  forward.
- Store CRUD round-trip and cascade-on-connection-delete.
- Validation table: every rejected field combination.
- `netproxy`: existing SOCKS5 tests still pass with the default `DialContext`,
  plus one asserting a custom dialer is actually used.

**Frontend**

- Panel renders loading, error, empty, and populated states.
- Toggle fires start/stop with the right payload; status dot reflects each of
  the five statuses.
- `0.0.0.0` bind shows the warning; `-R` + non-loopback shows the
  `GatewayPorts` note.

## Build order

1. `domain.SSHForward` / `SSHForwardState` + `types.ts` mirror.
2. `ssh_forwards` table + migration + store CRUD + tests.
3. `netproxy`: export `Relay`, add `SOCKS5Server.DialContext` + tests.
4. `sshmgr/forward.go`: registry, supervisor, three modes + tests.
5. Rule CRUD handlers (hub) + validation.
6. Lifecycle handlers (all roles) + `main.go` wiring.
7. `machineApi` / queries.
8. `SSHForwardsPanel` + dialog/module mounting + tests.

## Related work

Third of three independent features requested together, built last:

1. **Published SOCKS5** — `2026-08-06-published-socks5-design.md`.
2. **Host metrics charts** — `2026-08-06-host-metrics-charts-design.md`.
