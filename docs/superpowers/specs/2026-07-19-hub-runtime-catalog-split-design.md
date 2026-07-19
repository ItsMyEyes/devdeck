# Hub/Runtime Catalog Split — Design

**Date:** 2026-07-19
**Status:** Approved (brainstorming complete)

## Goal

The hub/runtime split is currently incomplete and, as a result, hard to
reason about. Only worktrees are genuinely runtime-owned — `WorkspaceService.List`
fetches them live from each machine and its comment states plainly that "the
hub never holds real worktree rows"
(`backend/internal/service/workspace.go:23-29`). Everything else still lives
on the hub, while a `--role runtime` process registers routes it never
serves: `/api/workspaces`, `/api/projects`, `/api/invoices`, `/api/news`,
`/api/todos` and friends are all mounted unconditionally
(`backend/cmd/server/main.go:298-398`), and the web UI is gated off entirely
(`main.go:448-450`). A runtime today is a headless execution daemon with a
large amount of dead surface area attached.

This project finishes the split along one clear line, and gives each runtime
its own web UI so it remains usable when the hub is down.

**The organising principle:**

> **The hub owns what is true. The runtime owns what is running.**

Which workspaces exist, which projects exist, and which machine each project
belongs to is *truth* — hub. Worktrees, PTY processes, files on disk, and SSH
credentials are *things running on one machine* — runtime. Every decision
below follows from that sentence.

## Decisions (from brainstorming)

1. **Hub stays the catalog source of truth.** Workspaces and projects remain
   hub-owned rows. Runtimes hold a local *replica* so they keep working when
   the hub is unreachable. Peer-to-peer gossip between runtimes was considered
   and rejected: with intermittently-online nodes (laptop + VPS) it converges
   only when two nodes happen to be up together, and it requires conflict
   resolution for no gain.
2. **A runtime replicates only its own slice.** Runtime A pulls all
   workspaces (they are the grouping) but only `projects WHERE machine_id = 'A'`.
   Rows for other machines are never sent, not merely hidden. A compromised
   VPS therefore cannot enumerate the operator's other clients' projects.
3. **Offline writes: projects yes, workspaces no.** With the hub down, a
   runtime may create projects (the common case: clone a repo and start
   working). Workspace create/rename/delete stays hub-only. Because a project
   is always bound to exactly one `machine_id`, two runtimes can never create
   the same project — replay is insert-only and needs no conflict resolution.
4. **Runtime UI is execution-scoped.** Project tree (own machine only),
   worktrees, terminal, explorer, git, agents, skills/MCP, tools, LSP, and
   SSH. Invoices, companies, banks, news, todos, and issues are hub-only:
   they are *one-operator business data*, not *one-machine data*, and
   replicating them would copy financial records onto every VPS for no
   reason.
5. **SSH splits three ways.** The hub keeps connection metadata (host, port,
   username, group, jump, `executor_machine_id`). The runtime owns
   `ssh_secrets` *and* `host_key_fingerprint`. The hub never holds either.
6. **Runtime auth: hub-signed handover token, with static key as the escape
   hatch.** Day to day, one login on the hub (password + TOTP) opens every
   runtime. With the hub down, the runtime's static `--key` still gets you
   in. This adds a verification path to the existing middleware rather than
   introducing a second auth system.

## Data ownership

```
HUB — source of truth                RUNTIME A — scoped to machine A
─────────────────────────            ──────────────────────────────────
users, sessions, pending_logins      workspaces      <- replica, read-only
machines                             projects        <- replica, machine_id=A
workspaces                                              (+ local offline inserts)
projects (all, +machine_id)          ssh_connections <- replica, executor=A
ssh_connections (metadata only)
issues, comments, attachments        ── authoritative, never sent to hub ──
invoices, companies, banks           worktrees
news, todos, recurring_templates     ssh_secrets, host_key_fingerprint
settings                             terminal, LSP, file, git state
```

`issues.project_id` has `REFERENCES projects(id) ON DELETE CASCADE`
(`backend/internal/store/db.go:52`). Because projects stay on the hub, this
FK — and the invoice/issue graph hanging off it — is untouched. This is a
concrete technical reason the catalog belongs on the hub rather than being
pushed down to runtimes.

### Changes from today

| | Today | After |
|---|---|---|
| `workspaces`, `projects` | hub only | hub + runtime replica |
| `worktrees` | already runtime-owned | unchanged |
| `ssh_connections` | hub only, executed on hub | hub catalog, executed on runtime |
| `ssh_secrets` | hub, hub key | runtime, runtime key |
| `host_key_fingerprint` | hub | runtime |
| invoice/news/todo/company/bank routes | mounted on runtime, unused | removed from runtime |
| web UI | `!isRuntime` (`main.go:448`) | served by both roles |

The invoice/news/todo row is pure cleanup — those routes already exist on
runtimes and are already never called.

## Catalog sync protocol

### Full snapshot, not deltas

One machine's catalog is small — tens of rows. The runtime pulls its
**entire slice** each cycle and overwrites the replica. Idempotent,
self-healing, no version numbers, no change log, and no window in which the
replica can be stuck half-applied.

The loop already exists: `machineclient.RunSelfRegisterLoop` runs every 30s
(`main.go:503-511`). We extend it rather than adding a second loop.

```
Every 30s, on runtime A:
  1. self-register with hub          (exists today)
  2. push projects WHERE origin='local'   (new — insert-only)
  3. pull catalog, overwrite replica      (new — full snapshot)
```

Push precedes pull so a project created offline comes back as a hub row in
the same cycle, never appearing twice.

The catalog payload is exactly three lists:

```json
{
  "workspaces":      [ /* all */ ],
  "projects":        [ /* WHERE machine_id = A */ ],
  "sshConnections":  [ /* WHERE executor_machine_id = A, metadata only */ ]
}
```

All three are replaced by the snapshot. **Only `projects` carries `origin`**
— workspaces and SSH connections are pure replicas with no local-write path,
so a snapshot replaces them wholesale. Concretely: with the hub down you can
create a project but you cannot create a workspace or an SSH connection.
Entering an SSH *secret* still works offline, because secrets are
runtime-owned and never part of this payload.

### Pull authentication

The runtime holds two credentials: `--hub-key` (the hub's bearer key) for
registration, and `--key` (its own key, which the hub also stores in
`machines.key`).

The pull uses the **runtime's own key**:

```
GET /api/runtime/catalog
Authorization: Bearer <runtime A's key>
```

The hub looks up the machine by the presented key, so there is no
`machineId` parameter at all — runtime A *structurally cannot* request
runtime B's catalog, because there is no way to express the request. The
hub key remains bootstrap-only, used for the initial registration.

This requires a new hub middleware that resolves a machine from a presented
key, mirroring the shape of `RequireKey` in
`backend/internal/handler/keyauth.go`. The lookup is against `machines.key`,
which already exists (`backend/internal/store/db.go:171`) and is already
distributed to browser clients by design (`backend/internal/domain/models.go:236`)
— so this reuses an existing credential rather than introducing one.

### The `origin` column

The runtime's `projects` table gains one column:

```sql
origin TEXT NOT NULL DEFAULT 'hub'   -- 'hub' | 'local'
```

A snapshot deletes only `origin='hub'` rows. Rows marked `'local'` — projects
created while the hub was down — survive the overwrite. Once pushed
successfully, the hub returns the canonical row and the runtime flips
`origin` to `'hub'`. One column replaces an entire outbox table.

**IDs never change during replay.** The runtime mints IDs with the existing
scheme (`p-` + `crypto/rand`, per `.claude/rules/go.md`) and the hub accepts
them verbatim. This is mandatory, not a preference: the runtime's
`worktrees.project_id` rows already point at that ID. If the hub reissued
IDs, every worktree created offline would be orphaned.

The replica also stores `last_synced_at`. A NULL value means *never synced*,
which the UI must render distinctly from *no projects* — otherwise a wrong
hub key looks identical to an empty account.

### Two failure cases with explicit policy

**The workspace was deleted meanwhile.** You create a project offline in
workspace W; the hub has since deleted W. Replay violates the FK. The hub
returns `409` and the runtime **keeps the row** as `origin='local'`, flagged
in the UI as *needs a workspace*. Work is never discarded because of an event
elsewhere.

**A project is deleted on the hub while its worktree is live.** The next
snapshot removes the project from the replica, but the worktree is still on
disk, possibly with unpushed commits.

> **Hard rule: a snapshot never deletes a worktree and never touches disk.**
> Orphaned worktrees stay visible in the runtime UI, labelled *orphaned*, and
> disappear only when the operator deletes them on that machine.

Deleting a catalog row is cheap and reversible. Deleting an unpushed worktree
is permanent loss. The two must never be triggered by the same remote event.

### Deliberately absent

No `updated_at`, no last-write-wins, no tombstones, no separate outbox table.
The `origin` column is the outbox. This follows directly from decision 3 and
should stay this way until a concrete need forces otherwise.

## Runtime UI authentication

Both paths end at the same place: **a session cookie issued by that runtime**.
Only the initial proof differs.

```
NORMAL (hub reachable)
  Browser --login password+TOTP--> Hub
  Browser --POST /api/machines/A/token--> Hub
          <-- Ed25519 token, aud=A, exp=60s
  Browser --GET https://runtime-a/?t=<token>--> Runtime A
          verifies signature with hub's public key
          <-- Set-Cookie + redirect to clean URL

FALLBACK (hub down)
  Browser --GET https://runtime-a/?key=<A's key>--> Runtime A
          <-- Set-Cookie + redirect to clean URL
```

### Signing key distribution

The hub already has `loadOrCreateAuthKey(*dbPath)` for AES (`main.go:157`).
Add a sibling `loadOrCreateSigningKey` producing an Ed25519 keypair.

The public key rides in the **self-register response** — no new endpoint, and
no bootstrap ordering problem, since a runtime cannot receive a token before
it has registered. The private key never leaves the hub, so a compromised
runtime can verify tokens but never mint them for another runtime.

### Token claims

Minimal: `sub` (user id), `aud` (machine id), `exp` (60 seconds).

`aud` is the load-bearing claim. A token for runtime A is invalid at runtime
B even though the same hub signed it; without it, one malicious runtime could
harvest tokens in transit and replay them elsewhere. The 60-second TTL
reflects that this is a handover token, not a session — once exchanged for a
cookie its job is done.

Because the token travels in a URL it lands in browser history, so the
runtime redirects to a clean URL immediately after setting the cookie. The
60-second TTL makes the residue useless.

Clock skew is tolerated at ±30 seconds. If verification still fails, the
sign-in page offers the key path.

### Runtime middleware

`RequireKey` (`main.go:453-454`) becomes `RequireRuntimeAuth`, accepting:

| Path | Used by | Exists today? |
|---|---|---|
| Session cookie | runtime UI in a browser | new |
| `Authorization: Bearer <machine key>` | `machineClient.ts` direct mode | **yes — must not change** |
| `?key=` query param | direct WebSockets (`machineClient.ts:193`) | **yes — must not change** |
| `?t=` hub token | one-shot handover from hub | new |

The two existing paths are load-bearing for today's hub UI. This is an
*additive* change, mirroring `RequireAuth` on the hub, which already accepts
cookie **or** bearer key (`backend/internal/handler/middleware.go:109-121`).

### Sign-in page

Opening `https://runtime-a/` with no credential shows a small page with two
options: *Sign in via hub* (redirects to the hub, which returns with a token)
and a field to paste the static key. The second is what saves you when the
hub is down.

### Accepted trade-off: revocation does not propagate

Logging out or deleting a session on the hub does not kill an already-issued
runtime cookie; it lives until it expires.

Fixing this properly would require the runtime to consult the hub on every
request, which defeats the entire purpose — the runtime would die whenever
the hub does. We accept it, with two dampeners: the runtime session TTL is
deliberately short (12 hours) rather than matching the hub's longer-lived
session, and removing a machine from the hub registry still cuts the
hub-proxy path immediately.

For a lost laptop, the correct response is rotating that runtime's `--key`,
not waiting for revocation to propagate.

## Route split

The test for placing a route: **would the answer differ if asked of another
machine?** If yes → runtime. If no → hub. `GET /api/invoices` answers
identically anywhere → hub. `GET /api/agents/claude/skills` differs per
machine → runtime.

**Hub only**
```
/api/auth/*                          (already)
/api/machines/*  + proxy             (already)
/api/seed, /api/browser/*            (already)
/api/settings
POST|PATCH|DELETE /api/workspaces
PATCH|DELETE /api/projects/{id}
/api/issues|attachments|comments|events
/api/invoices|companies|banks|recurring-templates|news|todos
POST|PATCH|DELETE /api/ssh/connections

new:
GET  /api/runtime/catalog            <- pulled by runtime, machine-key auth
POST /api/runtime/projects           <- outbox replay, insert-only
POST /api/machines/{id}/token        <- Ed25519 handover token
```

**Runtime only**
```
/api/worktrees/*  (+ files, git)     (already runtime-owned)
/ws/terminal, /ws/lsp                (already)
/api/fs/*, /api/proxy/start          (removed from hub)
/api/agents/*                        (removed from hub)
/api/tools/*                         (removed from hub)

moved from hub:
/ws/ssh
/api/ssh/connections/{id}/files      (SFTP browser)
/api/ssh/connections/{id}/accept-hostkey
new:
PUT /api/ssh/connections/{id}/secret <- credentials, never sent to hub
```

**Both roles**
```
/api/health, /api/whoami, /api/tailscale-status
/                                    <- the same UI bundle
GET /api/workspaces                  <- hub: all. runtime: replica.
POST /api/workspaces/{wsId}/projects <- hub: normal. runtime: origin='local'.
```

The last line is decision 3 made concrete. Its corollary is precise:
**`DELETE /api/projects/{id}` on a runtime is permitted only when
`origin='local'`** — removing something that never reached the hub is purely
local. Once `origin='hub'`, deletion must go through the hub.

`/api/agents/*` and `/api/tools/*` leave the hub because both read agent
installs and binaries from a machine's disk; the hub's answer is never
relevant. The hub UI still reaches them through the existing machine proxy,
and `--role both` keeps the solo self-hosting scenario intact.

### SSH detail: the fingerprint moves too

`ssh_connections.host_key_fingerprint` (`db.go:185`) moves to the runtime
rather than staying with the rest of the metadata on the hub.

TOFU means *"this machine has seen this host key before"* — a statement owned
by the observer, not the host. Stored on the hub, runtime B would inherit
runtime A's observation and the trust-on-first-use property would be lost.
There is also a practical gain: a hub-side fingerprint would require a
write-back path from runtime to hub on every pin, and keeping it local leaves
`POST /api/runtime/projects` as the *only* runtime→hub write direction.

### Frontend

One bundle, two contexts. `/api/whoami` is extended to
`{status, role, machineId?, machineName?}`; `status` is preserved because
`machineclient.Probe` checks only for a 200 (`backend/internal/handler/health.go:16-29`).

When `role === 'runtime'` the UI hides Invoices/Companies/Banks/News/Todos/
Issues and Machines, calls its own local `/api/*` instead of
`machineClient.ts`, and marks `origin='local'` projects as *not yet synced*.
When `role === 'hub'` everything behaves exactly as it does today.

`machineClient.ts` is not modified. It is the hub→runtime path, and that path
stays.

## Failure modes and error handling

> **Governing rule: a sync failure never empties the UI.** A stale replica is
> always better than a blank screen.

A failed poll serves the previous data with its age shown — not an empty list
indistinguishable from "you genuinely have no projects".

| Condition | Behaviour | Already handled? |
|---|---|---|
| Hub down, runtime up | Runtime UI fully functional. Catalog frozen at last snapshot. New projects become `origin='local'`. Workspace CRUD disabled with a stated reason. | new |
| Runtime down, hub up | Machines UI marks it unhealthy (15s poller, `main.go:198`). Its projects still listed, worktrees empty — `WorkspaceService.List` already logs and continues (`workspace.go:52-55`). | **yes** |
| Connected but direct path blocked | `machineClient.ts` falls back to the hub proxy, 30s TTL (`machineClient.ts:62-68`). | **yes** |
| Wrong hub key, never pulled | Replica empty. **Must** render "never synced", not "no projects". | new |
| Runtime clock skewed | 60s token fails verification. ±30s tolerance; if it still fails, the sign-in page offers the key path. | new |

### Snapshot applies in one transaction

Deleting `origin='hub'` rows and writing the new ones happens in a **single
SQLite transaction**. A mid-apply failure — full disk, locked db, killed
process — rolls the replica back intact. There is never a state where
workspaces are deleted but their replacements have not landed.

### Retry policy

Push and pull both fail quietly and safely: logged, retried on the next 30s
cycle. No exponential backoff — a 30-second interval is already generous, and
backoff would only slow recovery.

A failed push leaves `origin='local'` as is. Because replay is insert-only
with stable IDs, retrying is always safe: a hub that already accepted the row
responds idempotently rather than duplicating it.

### Known hazard, deliberately not defended against

**Cloned VPS.** Cloning a machine clones its `--key`, so two processes
register as the same machine, pull the same catalog, and create worktrees
invisible to each other.

Detecting this correctly means tracking instance identity and deciding a
winner — a policy engine for a rare event. Instead: the runtime generates a
random instance id at startup and sends it with registration; if the hub sees
a machine's instance id flapping, it logs a warning and flags it in the
Machines UI. **Diagnosis, not enforcement.** The frustrating part of this
scenario is not that it happens but that nothing hints at it when it does.

### Error shape

All new errors use the `{"error":"..."}` envelope and `handleStoreErr()` per
`CONTRACTS.md`. No new shapes, no exceptions.

## Testing

Seven tests carry the decisions above; each fails when its decision is
violated.

| Test | Protects |
|---|---|
| Runtime A's key is rejected when requesting B's catalog | Cross-machine isolation (decision 2) |
| A snapshot never deletes `worktrees` rows | The "never touch disk" hard rule |
| A snapshot never deletes `origin='local'` projects | Offline mode (decision 3) |
| Replay preserves the project ID verbatim | Offline worktrees are not orphaned |
| A token with `aud=A` is rejected by runtime B | Machine-bound tokens (decision 6) |
| `Bearer <key>` and `?key=` are **still** accepted by runtimes | Regression guard for `machineClient.ts` |
| A snapshot failing mid-apply rolls back cleanly | Single-transaction apply |

The sixth is the easiest to break and the most expensive: it protects the
path today's hub UI already depends on. If it breaks, every currently working
runtime feature fails silently.

Layers follow existing practice: `go test` units for store and service,
handler tests for the new middleware and endpoints, `npm run typecheck` for
the frontend, and the `verify` skill (`.claude/skills/verify/SKILL.md`),
which already launches isolated hub/runtime instances with Playwright — the
right tool for the two scenarios units cannot cover: **kill the hub, confirm
the runtime UI still works**, and **create a project with the hub down, bring
the hub back, confirm it appears there**.

## Build order

Each phase stands alone, delivers value alone, and can be stopped at without
leaving anything half-built.

```
1. Runtime UI + key->cookie auth      <- no data-model changes
2. Catalog replica (read-only)
3. Offline project create + replay
4. Hub-signed SSO token
5. SSH migration to runtime
6. Route cleanup + UI role gating
```

**Phase 1 first** because it is the serving-and-auth foundation with zero
schema changes and zero sync: the runtime serves the UI and you sign in with
the static key. Note the honest limit — until phase 2 lands, the runtime's
`projects` table is empty, so the project tree renders as *never synced*.
Phase 1 alone proves the UI, the middleware, and the sign-in page; **phases 1
and 2 together** are what deliver the original requirement, *the runtime is
reachable and usable from anywhere while the hub is down*. Treat them as the
first shippable milestone.

**Phase 4 is deliberately late.** SSO is convenience, not a prerequisite: the
key path from phase 1 already makes everything usable. Building the
cryptography earlier would mean building it before anything needs it.

**Phase 5 is last before cleanup** because it touches credentials, the most
expensive thing to get wrong, and it lands once the sync machinery is proven
by phases 2–3.

### Existing SSH credentials: re-enter, don't migrate

`ssh_secrets` today is encrypted with the hub's `authKey`. Migrating it means
building a one-time path that decrypts on the hub and ships plaintext to a
runtime — precisely the capability this design removes, written as permanent
code for a single use.

Instead, the hub UI flags which connections lack a secret on their runtime,
and the operator enters it once in the runtime UI. For a solo operator with a
handful of connections this is a few minutes, traded against never writing
code that can drain every SSH credential from one place.

### Orchestration note

All six phases touch the same convergence files — `backend/cmd/server/main.go`,
`backend/internal/domain/models.go`, `frontend/src/store/types.ts`,
`backend/internal/port/store.go`, `frontend/src/store/useDevDeckStore.ts`.
`CLAUDE.md` forbids editing these from parallel agents. **Phases run
sequentially, not fanned out.** Parallelism is available *within* a phase,
and only after that phase's convergence-file changes have landed.
