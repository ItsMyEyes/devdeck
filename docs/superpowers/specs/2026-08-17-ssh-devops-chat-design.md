# SSH DevOps Chat — Design

**Status:** approved (brainstorm 2026-08-14 → 2026-08-17)
**Plan:** `docs/superpowers/plans/2026-08-17-ssh-devops-chat.md`

## 1. Purpose

Give every saved SSH connection a chat panel whose agent can actually operate
the host it is docked to: read remote files, run diagnostic commands, and —
behind an approval gate — change things. The panel lives in the SSH pane's
right rail, next to Stats and Port Forwarding.

The agent reaches the host through DevDeck's own HTTP API, never through its
own SSH client. That is what makes the feature runtime-agnostic: any CLI agent
with a shell tool (`claude`, `pi`, and whatever comes next) can drive it, and
nothing about the capability set is per-provider.

## 2. Decisions already settled

These came out of the brainstorm and are not open:

| # | Decision |
|---|----------|
| D1 | Execution path: agent process runs locally (hub), remote work goes through DevDeck's pooled SSH connection. An "agent drives the interactive terminal" mode is wanted but **user-selected up front**, and is deferred to a follow-up spec. |
| D2 | Thread scope: one thread per SSH connection, plus optional extra chats (`::chat-N`). History survives closing the tab and restarting the server. |
| D3 | Permission policy surface: the existing `RuntimeMode` pill. No new policy UI. |
| D4 | The approval gate lives in **our** tool layer, not in a provider-native broker. Same behaviour for every runtime, no per-provider code. |
| D5 | Tool transport: a **helper CLI** the agent calls from its shell, plus **skill files** that teach it the commands. Not MCP. (The service layer is transport-neutral, so an MCP façade later is additive.) |
| D6 | Skill delivery: a per-thread workspace directory on disk, seeded with `AGENTS.md` + `SKILL.md` + a session binding file. No prompt preamble. |
| D7 | `@`-mention of a remote file inserts the **path only**; the agent reads it through a tool if it needs the contents. |

## 3. Architecture

### 3.1 Thread namespace

Thread IDs gain a second shape:

```
w-<hex>[::chat-N]        worktree thread   (existing, unchanged)
ssh:<connectionId>[::chat-N]   SSH thread   (new)
```

Two call sites assume "thread ⇒ worktree" today and become namespace-aware:

- `handler/agent_ws.go:270` `resolveInstanceID`
- `cmd/server/main.go:474` `Reactor.InstanceFor`

Everything else in orchestration is already thread-id-opaque.

### 3.2 Where the agent process runs

The hub process. Not a style choice: `sshFilePool`, the SSH credentials, and
every `/api/ssh/...` route are hub-scoped (`main.go:377`, hub-only block at
`main.go:733+`). A connection's `ExecutorMachineID` only moves the *TCP dial*
through a runtime's SOCKS5 proxy; the pool itself stays on the hub.

Consequence: the hub host must have a CLI agent installed. For `--role both`
and the desktop app that is the process the user already runs. For a headless
hub with no agent binary, the session fails to start and the failure surfaces
through the pane's existing thread-error path (`AgentThreadView.error`, already
rendered by `AgentChatPane`) — the operator sees the real reason, not silence.

A dedicated "no agent installed on the hub" empty state is **not** in v1: the
agents API is machine-scoped (`keys.agents(machineId)`), so a hub-scoped variant
would have to be invented for cosmetics alone. Revisit if the error text proves
too opaque in practice.

### 3.3 Socket

The SSH chat pane connects hub-direct — `window.location.host`, the same way
`sshClient.ts:14` builds the `/ws/ssh` URL — not through `machineWsUrl`.
`useAgentChatSocket` takes a target union instead of a bare `Machine`:

```ts
type AgentChatTarget =
  | { kind: 'machine'; machine: Machine }   // worktree threads
  | { kind: 'hub' }                          // SSH threads
```

### 3.4 Full loop

```
composer → /ws/agent (hub) → Engine → Reactor → adapter spawns CLI
   cwd = <dataDir>/ssh-threads/<slug>/
         ↓ agent reads AGENTS.md + SKILL.md, runs the helper CLI
   devdeck-ssh exec/read/list/grep/write
         ↓ HTTP + thread token
   /api/agent-tools/ssh/*  →  SSHToolService  →  sshmgr pool  →  remote host
         ↑ (gated calls block here until the user answers)
   result → agent stdout → Ingestion → events → /ws/agent → timeline
```

## 4. Tool surface

### 4.1 REST (new)

Route group `/api/agent-tools/ssh/*`, wrapped by `RequireThreadToken` using the
nested-mux pattern already used for `/api/runtime/catalog` (`main.go:727`), and
listed in `RequireAuth`'s `publicPaths` so the outer middleware defers to it.

| Method + path | Body / query | Response |
|---|---|---|
| `POST /api/agent-tools/ssh/exec` | `{"command":"…","timeoutSec":60}` | `{"stdout","stderr","exitCode","durationMs"}` |
| `GET /api/agent-tools/ssh/file` | `?path=` | `service.SSHFileContent` (reused verbatim) |
| `GET /api/agent-tools/ssh/files` | `?path=` | `{"entries":[…]}` wrapping `[]service.SSHFileEntry` |
| `GET /api/agent-tools/ssh/grep` | `?q=` | `service.GrepResult` (reused verbatim) |
| `PUT /api/agent-tools/ssh/file` | `{"path":"…","content":"…"}` | `service.SSHFileContent` (reused verbatim) |

The four file routes deliberately expose no options beyond `path`/`q`: line
ranges, scoped searches, and every other flag go through `exec` (`sed -n
'40,80p'`, `tail -n 200`, `grep -rn PATTERN /etc/nginx`), which classifies
read-only and therefore runs ungated. Adding range and scope parameters here
would duplicate, less well, what the shell already does — and would widen the
one surface every remote action passes through. The response shapes are the
`SSHFileService` types verbatim, so this group can never drift from the
explorer's own view of the same filesystem.

**The connection id is never a parameter.** It is read from the token. An agent
holding one thread's token cannot reach another connection — the tool surface
has no vocabulary for it.

Errors use the standard `{"error":"message"}` envelope (CONTRACTS.md). A denied
approval is `403` with `{"error":"denied by user"}`; a timed-out approval is
`403` with `{"error":"approval timed out"}`.

### 4.2 Command classification

`sshtool.Classify(command string) Class` returns `ClassRead` or `ClassMutate`,
defaulting to `ClassMutate` whenever it is unsure. Pure function, no I/O.

- `ClassRead` only when **every** segment of the command (split on `|`, `&&`,
  `||`, `;`) has a first word in the read-only allowlist: `ls cat head tail
  grep egrep fgrep rg find stat file wc df du free uptime uname whoami id ps
  top journalctl dmesg hostname date env printenv systemctl docker kubectl git
  ss netstat ip ping curl wget nproc lsblk lsof sensors`.
- `systemctl`, `docker`, `kubectl`, `git`, `curl`, `wget` are read-only **only**
  with a read-only subcommand/flags (`systemctl status|show|list-units|is-active`,
  `docker ps|logs|inspect|images|stats`, `kubectl get|describe|logs|top`,
  `git status|log|diff|show`, `curl`/`wget` without `-o`/`-O`/`--output`).
- Any redirection (`>`, `>>`), any `sudo`, any backtick/`$(`, and any unknown
  binary ⇒ `ClassMutate`.

Conservative by construction: mis-classifying a read as a mutation costs one
approval click; the reverse costs a production incident.

### 4.3 Policy

Read from the thread's `RuntimeMode` in engine state at call time:

| RuntimeMode | read | mutate |
|---|---|---|
| `full-access` | run | run |
| `auto` | run | **gate** |
| `auto-accept-edits` | run | **gate** |
| `approval-required` | **gate** | **gate** |

`acceptForSession` on any request marks the thread session as
"auto-approve mutations" until the session stops or the thread is cancelled.

### 4.4 Approval gate

`approval.Gate` implements the existing `approval.Broker` interface **plus** a
blocking `Await`. The existing UI is reused wholesale — `ComposerPendingApprovalPanel`
already renders `request.opened` and dispatches `thread.approval.respond`.

`Gate` **replaces** `approval.MemoryBroker`, which is what `main.go:456` wires
today. MemoryBroker already tracks open requests per thread and fans
cancellation out through `OnCancel`; what it cannot do is block, because
nothing needed blocking when every approval was answered by writing to a CLI's
stdin. An HTTP handler parked on a human does need it. `Gate` therefore carries
MemoryBroker's `OnCancel` verbatim and adds `Await` + the session-accept flag,
and MemoryBroker is deleted rather than left as a second, subtly weaker broker.

1. Handler mints `requestID = "tool-" + randomHex(8)`.
2. It injects a synthetic `event.Event{Type: event.RequestOpened, ThreadID,
   RequestID, Payload: &event.RequestOpenedPayload{…}}` through the **existing**
   ingestion path (new exported `Ingestion.Inject`), so the status/pending
   bookkeeping (`CmdThreadActivityAppend` + `CmdThreadSessionSet` with
   `pendingRequestAdd`) is byte-for-byte what a provider request produces.
   - `RequestType`: `command_execution_approval` for exec, `file_change_approval` for write.
   - `Detail`: the exact command, or the target path.
   - `Options`: `accept`, `acceptForSession`, `decline`.
3. `gate.Await(ctx, threadID, requestID)` blocks, ctx capped at **10 minutes**.
4. The user answers → `thread.approval.respond` → Reactor → `Broker.Resolve` →
   `Await` returns. Reactor **skips** `Provider.RespondToRequest` for
   `tool-`-prefixed request ids: there is no provider counterpart to answer.
5. Handler injects `event.RequestResolved` (which clears the pending flag and
   returns the thread to running), then runs or refuses.
6. Interrupt / session exit → `Broker.CancelThread` → every pending `Await`
   returns `decline`, so no HTTP request hangs after its thread dies.

## 5. Thread workspace and skills

Per thread: `<dir(dbPath)>/ssh-threads/<slug>/` where `slug` is the thread id
with `:` and `/` replaced by `-`. Seeded (overwritten) on **every** session
start, so skill text ships with the binary and can never drift:

```
AGENTS.md                          ← conventions + how to call the helper CLI
CLAUDE.md                          ← same content (Claude reads this name)
.claude/skills/devops-ssh/SKILL.md ← the skill, in the format detect.ReadSkills parses
.devdeck/session.json              ← 0600: hubUrl, threadId, connectionId, label, host, user, token
```

The token is never written into `AGENTS.md` or any file the agent is asked to
quote back, and never appears in the transcript.

## 6. Tool CLI

> **Amended after implementation review (F3).** This section originally
> specified a new binary `backend/cmd/devdeck-ssh`. Shipping a second executable
> turned out to be the feature's single largest failure surface — it had to be
> cross-compiled for six targets, renamed past the release's
> `devdeck-* → devdeck-runtime-*` step, added as a second Tauri `externalBin`,
> signed, and landed on the operator's PATH under exactly the name `devdeck-ssh`,
> and it could not work under `go run` at all. Any one of those missing produced
> a hub whose every tool call answered `command not found`.
>
> What shipped instead: `backend/internal/sshtoolcli`, entered as
> **`devdeck ssh-tool`** — a subcommand of the binary that is already running the
> hub, dispatched at the top of `main` before any config or database work.
> `sshthread.Seed` writes a `bin/devdeck-ssh` shim into each thread's workspace
> forwarding to `os.Executable()`, and that workspace `bin/` is what `main.go`
> prepends to the agent's PATH. The agent's contract below is unchanged — it
> still invokes a bare `devdeck-ssh` — but there is nothing for an operator to
> install, and a moved or upgraded install self-corrects, because Seed re-runs on
> every session start. `cmd/mcp-server` was folded in the same way
> (`devdeck mcp-server`, `internal/issuemcp`).

Resolves its session from `$DEVDECK_SSH_SESSION` or `./.devdeck/session.json`.

```
devdeck-ssh exec  <command...>          # runs remotely, prints stdout/stderr
devdeck-ssh read  <path>
devdeck-ssh list  <path>
devdeck-ssh grep  <pattern>
devdeck-ssh write <path>                # content on stdin
```

No flags beyond those shown, mirroring §4.1: ranges and scoping belong to
`exec`. `exec` is request/response, not streaming — there is no follow mode,
and the skill file says so, because an agent that expects `tail -f` to return
will hang on its own.

Exit codes: `0` ok · `1` usage/transport/auth failure · `2` remote command
exited non-zero (stdout/stderr still printed) · `77` denied by the user.

## 7. UI

- Third rail button in `SSHRightSidebar.tsx` (lucide `Bot`), same
  open/close/switch behaviour as Stats and Forwards; `SSHRightSidebarPanel`
  gains `'chat'`.
- The panel renders the existing `AgentChatPane` with
  `target={{kind:'ssh', connectionId}}` and `threadKey="ssh:<connectionId>"`.
  Worktree-only props (`worktreeId`, `branch`, `worktreeLabel`) become optional.
- `@`-mention reuses the composer's existing mention machinery
  (`composerMention.ts`); only the suggestion **source** switches — SSH threads
  query `/api/ssh/connections/{id}/files/search`. The inserted token is the
  absolute remote path, nothing more (D7).
- Empty state when the hub reports no installed agent.

## 8. Error handling

| Condition | Behaviour |
|---|---|
| SSH host unreachable | `502` + envelope; CLI prints and exits 1; agent sees a real error string |
| Remote exit ≠ 0 | `200` with `exitCode` set; CLI exits 2 — a failing command is data, not a transport error |
| Approval declined | `403 denied by user`; CLI exits 77; agent is expected to stop and ask |
| Approval timeout (10 min) | `403 approval timed out`; pending card resolved as `cancel` |
| Token missing/invalid | `401`; CLI prints "session expired — ask the user to restart the chat" |
| Thread interrupted mid-call | pending `Await` returns `decline` immediately |
| No agent binary on hub | session start fails; the reason reaches the pane through `AgentThreadView.error` |

## 9. Testing

Go: table tests for `Classify`; concurrency tests for `Gate`
(await/resolve/cancel/timeout/double-resolve); `TokenStore` mint/verify/revoke;
`SSHToolService` against a fake executor interface (**no real SSH in tests**);
handler tests via `httptest` with a fake service; workspace seeding on a temp
dir; namespace helper tests.

Frontend (vitest): hub-vs-machine URL selection, rail button toggle, pane
target routing, SSH mention source. Known baseline: `npm test` has one
pre-existing Monaco guard failure — not a regression.

## 10. Out of scope (this spec)

Agent-drives-the-interactive-terminal mode (needs a session registry and an
input-injection path `sshmgr.Server` does not have today) · MCP façade ·
cross-connection tools · file upload/download by the agent · interactive sudo
password prompts · Windows remote hosts.

## 11. Assumptions taken without a round-trip

Recorded because the user delegated sections 2–6 to move straight to
implementation:

1. Thread id form is `ssh:<connectionId>` (colon, not a second `ssh-` prefix).
2. Approval timeout is 10 minutes.
3. `acceptForSession` scope = the thread's session, mutations only.
4. Workspace lives beside the SQLite DB, alongside `auth.key`/`signing.key`.
5. Tokens are in-memory (lost on restart, re-minted on next session start) —
   no schema change, no new store method.
6. ~~The helper CLI is a separate binary, matching `cmd/mcp-server` precedent.~~
   **Reversed in implementation (see §6):** the tool CLI is a subcommand of the
   DevDeck binary reached through a generated workspace shim, and
   `cmd/mcp-server` followed it rather than setting the precedent. A second
   artifact meant a second thing to build, ship, sign and put on PATH, and the
   feature was dead in every case where one of those was missed.
