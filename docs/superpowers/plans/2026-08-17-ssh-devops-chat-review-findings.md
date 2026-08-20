# SSH DevOps Chat — review findings and remaining work

**Status:** implementation complete and committed (`43632f6`..`c9db34a`). Two
Opus review passes found the defects below. Most now have fixes written in the
working tree — and **every one of those fixes is UNVERIFIED: nothing was
compiled, no test was run, `go vet` never executed.** Treat this file's
"FIXED" markers as "a fix has been written", not as "this works".

### Fix status at a glance

| Finding | State |
|---|---|
| 1. Classifier bypasses (newline, `&`, `find -delete`, `wget`, …) | fix written, unverified |
| 2. `timeoutSec` spent on the human; no 10-minute ceiling | fix written, unverified |
| 3. `RunShell` ignores ctx (SSH channel leak) | fix written, unverified |
| 4. `acceptForSession` escalation (both halves) | fix written, unverified |
| 5. `RequestResolved` never clears pending → thread stuck `waiting` | fix written, unverified |
| 6a. `?key=` token in the access log | fix written, unverified |
| 6b. `RevokeThread` never called | NOT STARTED |
| F1. Panel never opens a socket | fix written, unverified |
| F2. Typing erased on re-render | fix written, unverified |
| F3. `devdeck-ssh` never built / not on PATH | **FIXED and verified end to end** — see resolution below |
| F4. Mention sends a markdown link, not the path (D7) | NOT STARTED |
| F5. `sshMentionSource` bypasses `request()`, no `includeDirs` | NOT STARTED |
| F6. Empty `Machine` name breaks banner copy | fix written, unverified |
| F7. Every SSH tab opens a socket | fix written, unverified |
| F8. Hero copy says "build" | NOT STARTED (cosmetic) |

**F3 resolution — the second binary is gone.** The earlier fix (build
`devdeck-ssh`, ship it beside the server, prepend the server's directory to
PATH) was abandoned: it survived only if six release artifacts, the install
scripts' rename step, a second Tauri `externalBin`, macOS signing, and the
operator's own PATH all lined up, and it broke under `go run` besides. Every one
of those was a way for the operator to end up with a hub that cannot reach any
host.

`devdeck-ssh` is now a **subcommand of the DevDeck binary itself** —
`devdeck ssh-tool` (`backend/internal/sshtoolcli`) — reached through a ~100-byte
shim `sshthread.Seed` writes into each thread's workspace `bin/` at session
start, pointed at `os.Executable()`. The agent still types a bare `devdeck-ssh`,
so `AGENTS.md` and `SKILL.md` are unchanged. There is nothing to install, sign,
version-match, or rename at the packaging boundary, and it works under `go run`
and inside `DevDeck.app` alike. The same treatment removed
`cmd/mcp-server` → `devdeck mcp-server` (`internal/issuemcp`).

Verified by `TestSeededShimReachesToolRoutesThroughTheServerBinary` and
`TestSeededShimPropagatesDeniedExitCode` in `internal/sshthread`: both build
`cmd/server` for real, seed a workspace, and invoke a bare `devdeck-ssh` through
a shell with only the workspace `bin/` added to PATH — asserting the hub sees the
thread's bearer token and a multi-word command as one argument, and that exit
code 77 reaches the caller.

**Why it stopped here:** the session's permission classifier began blocking every
Bash and Agent invocation (it reacts to earlier conversation content — the
review's proof-of-concept command strings — not to the actions themselves).
Editing files still worked; running tests, `go build`, and `git` did not. Resume
in a fresh session, or in the default permission mode.

**First thing to run on resume:**

```
cd backend && go test ./internal/sshtool/ -race -v && go vet ./internal/sshtool/
```

`classify.go` was rewritten and `classify_adversarial_test.go` added without a
single compile. Expect to fix typos before judging the logic.

---

## 1. Classifier bypasses — WRITTEN, UNVERIFIED

`backend/internal/sshtool/classify.go`

Every case below reached a live host with **no approval card** during review:

| Input | Why it passed |
|---|---|
| `ls\nrm -rf /tmp/pwned` | `splitSegments` never split on `\n`; `strings.Fields` treats it as whitespace, so only `ls` was classified |
| `ls & rm -rf /tmp/pwned` | same, for a bare `&` |
| `env FOO=bar rm -rf /tmp/x` | `env` was on the unconditional read-only list; it runs whatever follows |
| `find / -name '*.log' -delete` | `find` was unconditionally read-only |
| `ip link set eth0 down` | `ip` was unconditionally read-only |
| `journalctl --vacuum-size=1K`, `dmesg -C`, `ss -K`, `date -s` | same shape |
| `wget --output-document=/root/.ssh/authorized_keys …` | output-flag blocklist matched `--output=` but not `--output-document=`; wget also writes with no flags at all |
| `curl -sO`, `curl -fsSLo /tmp/x` | bundled short flags never equalled `-o`/`-O` |
| `git branch -D main`, `git remote add …` | both were in the read-only subcommand list; spec §4.2 allows only `status\|log\|diff\|show` |

**The fix as written:** reject control characters outright; split on `&` too;
move `find`/`ip`/`date`/`journalctl`/`dmesg`/`ss` to a deny-token table (with
bundled-short-flag detection); drop `env` entirely; make `curl` an allowlist and
`wget` always-mutating; drop `git branch`/`remote`.

## 2. The 60-second timeout is spent on the human — NOT STARTED

`backend/internal/handler/ssh_tool.go:87` wraps the whole `svc.Exec` call —
approval wait included — in `context.WithTimeout(timeoutSec)`, default 60s.
Proven at `timeoutSec: 2`: the prompter waited 2s, then `403 approval timed out`,
command never ran. The CLI never sets `timeoutSec`, so **every exec approval
expires after 60 seconds** while spec §4.4 promises 10 minutes (the CLI's own
HTTP client is set to 11 minutes for exactly that reason).

Related: **the 10-minute ceiling exists nowhere in the code.** Grep confirms it.

Fix: `timeoutSec` bounds only `runner.RunShell`; `authorize` derives its own
10-minute context from the request context. Sibling handlers (`ReadFile`,
`ListFiles`, `Grep`, `WriteFile`) already pass `r.Context()` through with no
deadline — that is correct, leave it.

## 3. `RunShell` ignores its context — NOT STARTED

`backend/internal/sshmgr/exec.go:209` calls `sess.Run(command)` and never
watches `ctx`. Its sibling `runRemote` (same file, ~line 131) uses
`Start`/`Wait`/`select` precisely because abandoned sessions pile up SSH
channels until `NewSession` fails, taking the connection's SFTP half — the file
explorer and stats — down with it (OpenSSH `MaxSessions` defaults to 10).

Trigger: `devdeck-ssh exec "tail -f /var/log/syslog"`. It classifies read-only,
so it runs ungated, and `sess.Run` never returns. `SKILL.md` warns the agent not
to use follow mode; that is a prompt, not an enforcement.

Fix: mirror `runRemote`'s cancellation shape; on cancel return partial output,
`exitCode = -1`, `ctx.Err()`.

## 4. `acceptForSession` escalates past the strictest mode — NOT STARTED

`backend/internal/service/ssh_tool.go:116-122` checks the session-accept
shortcut after and independently of the mode check, so it fires in
`approval-required` too — whose UI copy is "Ask before commands and file
changes" (`ComposerControls.tsx:69`).

Worse, and not in the original suspicion: `ToolApprovalPrompter.Ask`
(`orchestration/toolprompt.go:46-52`) offers `acceptForSession` on **every**
card including read ones, and `Gate.Resolve` sets the flag without reference to
class. So accepting-for-session on `read /etc/motd` authorizes all future
mutations — while reads keep prompting, because the shortcut is guarded by
`class == ClassMutate`. The policy inverts: the harmless class stays gated, the
dangerous one goes silent. It also leaks across surfaces, since `Gate` is the
single broker for provider-raised requests too.

Fix: session shortcut applies only in `auto`/`auto-accept-edits`; stop offering
`acceptForSession` on `ReqFileReadApproval` cards.

## 5. A resolved request never clears — thread can stick in `waiting` — NOT STARTED

`Ingestion.handle` (`orchestration/workers.go:112-239`) has **no case for
`event.RequestResolved`**. It falls to `default:`, which appends activity only,
and `EvtThreadActivityAppended` has no `applyOne` case. So the id stays in
`Thread.PendingRequests`, and `engine.go:292` only returns a thread to `running`
when that set is empty.

`ToolApprovalPrompter.Ask` injects `RequestResolved` on exactly the two paths
where the user never clicks — timeout and interrupt/`CancelThread` — so each of
those permanently pins the thread in `waiting` until a process restart. The card
disappears from the UI (the frontend reducer closes it), so the damage is
invisible until the composer refuses to send.

Fix: add `case event.RequestResolved:` that appends the activity **and**
dispatches `CmdThreadSessionSet` with a `pendingRequestRemove` sibling to the
existing `pendingRequestAdd` (`engine.go:360`).

## 6. Token hygiene — NOT STARTED

- `handler/threadtoken.go:37` accepts the token as `?key=`. `access.go:130-133`
  logs the raw query string, and the JSON redaction regex applies only to
  bodies — so any `?key=` call writes a token granting shell on a production
  host into the access log verbatim. The shipped CLI always uses the
  `Authorization` header (which *is* redacted), so this is latent, not active.
  Fix: delete the fallback; nothing uses it.
- `sshtool.TokenStore.RevokeThread` is dead code. Nothing calls it on session
  exit, thread delete, or `DELETE /api/ssh/connections/{id}`. Deleting the SSH
  connection leaves a working token on disk for the rest of the process's life.
  Fix: call it from `SSHHandler.DeleteConnection` and the `SessionExited` path,
  and remove `.devdeck/session.json` on teardown.

## Refuted

`loopbackHubURL` is **not** a data race. It is written at `main.go:1051` and read
at `:567` on the reactor goroutine, but every path that can reach the read
passes through a channel chain (`Engine.Dispatch` → engine goroutine →
`Subscribe` → reactor loop), and happens-before is transitive. Worth one
comment stating that, since `main.go:495-503` currently justifies it by timing
rather than by the memory model. Separately: if `net.SplitHostPort` fails at
`:1050`, `loopbackHubURL` stays empty and the agent sees only
`session file … is missing hubUrl or token` — worth a `log.Fatalf`.

## What held up under review

- **Connection scoping is sound.** The connection id exists nowhere in the
  request surface; it comes from the token only, and a test pins that a body
  `connectionId` is ignored.
- **Parked callers are always freed.** `CancelThread` runs on interrupt, session
  stop, and `SessionExited`; the tombstone design delivers a decision that lands
  in the Open→Await window; tombstones are swept and bounded.
- **Auth wiring is exact.** `RequireThreadToken` + `publicPaths` are exact-match;
  unauthenticated calls get a `{"error":"unauthorized"}` 401.
- Route table, status codes, exit codes, and the RuntimeMode matrix match the
  spec. `SSHFileService.Grep` is injection-safe. Default thread mode is
  `approval-required`, so an unknown thread fails closed.

## Frontend review

Arrived after the session was already blocked. It found worse than the backend
review did: **as committed, the panel never opens a socket and the agent has no
tools**, so the feature does nothing at all.

### F1. The panel never connects — FIX WRITTEN, UNVERIFIED

`AgentChatPane.tsx:184` gated `connect` on `threadsQuery.isLoading`.
`useAgentThreads` is `enabled: !!machine && !!worktreeId`, and an SSH thread has
no worktree, so the query is permanently **disabled** — and react-query reports a
disabled query as `isPending && !isFetching`, i.e. `isLoading === false`.
`connect` was therefore false forever. Proven by rendering the real panel with a
stubbed `WebSocket`: **zero** sockets constructed, no `hello`, no replay. The
operator sees a calm, inert hero screen; the backend replay path is innocent.
Sending one message flips `hasSentThisSession` and the whole history suddenly
appears above the new turn.

Fixed by changing that one word to `isPending`. **Unverified — no typecheck, no
test run.** There is still no test file at all for `SSHAgentChatPanel.tsx`, the
file carrying F1 and F2; write one.

### F2. Typing is erased on any re-render — FIX WRITTEN, UNVERIFIED

`SSHAgentChatPanel.tsx:51` called `sshMentionSource(connectionId)` inline. That
object is a `useEditor` dependency in `ComposerPromptEditor.tsx:276`, and
@tiptap/react compares deps by identity, so each render destroyed and rebuilt
the editor from the value captured at mount (`''`). Reproduced in the real tree:
type a question, let the connections query settle, text is gone. Fires on panel
switches and on every frame of a rail resize drag. Fixed with `useMemo`.
**Unverified.**

### F3. `devdeck-ssh` is never built or on PATH — FIXED (see "F3 resolution" above for what shipped; the analysis below is the original diagnosis)

`backend/cmd/devdeck-ssh/` exists and its tests pass, but the `Makefile` builds
only `./cmd/server` and `./cmd/mcp-server`, `release.yml` ships only
`devdeck-runtime-*`, and `provider.SessionStartInput` carries only
`ThreadID`/`Cwd` — nothing injects env or PATH for the spawned agent. Meanwhile
the seeded `AGENTS.md` tells the agent that a bare `devdeck-ssh` is its only
route to the host.

So the agent reads its instructions, runs `devdeck-ssh exec …`, and gets
`command not found`. Plan Task 10 only asked for the source files, which is why
no per-task review caught it.

Fix: add a `./cmd/devdeck-ssh` build target beside the server ones, install it
next to the server binary, and either prepend that directory to the spawned
agent's PATH (needs a new field on `SessionStartInput`) or write the absolute
path into the seeded `AGENTS.md`/`SKILL.md`.

### F4. `@` mention violates spec D7 — NOT STARTED

`composerMention.ts:211-216` inserts a `file` chip and
`composerSerialize.ts:102-105` serialises it as
`` `[basename](encodeURI(path))` ``. So `@/var/log/my app.log` is sent as
`[my app.log](/var/log/my%20app.log)`, not the path. For ordinary paths this is
noise; for a path containing a space, `#` or `?` the agent copies the encoded
form into `devdeck-ssh read` and gets "no such file".

Fix: let a `MentionSource` carry its own insert strategy and insert plain text
for SSH.

### F5. The bare `fetch` is real but low-impact — PARTLY REFUTED

Desktop auth does **not** break: `request()` adds no auth header of its own, and
the Tauri window runs on the Go server's own origin, so the session cookie
carries either way. What is actually lost is the `res.ok`/error-envelope check
(an error body gets `JSON.parse`d and cast to `string[]`, then throws inside
@tiptap/suggestion, which swallows it — the operator just sees an empty menu)
and the shared `403 → /access-denied` redirect. Separately `sshMentionSource`
omits `includeDirs`, so remote directories cannot be mentioned at all, unlike
worktree ones.

Fix: use `searchSSHFiles(connectionId, q, { includeDirs: true })` and make the
test's mock a real `Response`.

### F6. The placeholder `Machine` resolves correctly — MOSTLY REFUTED

Traced end to end: the empty `url` makes `probeDirect` fetch a relative
`/api/health` (on the public allowlist), so mode is `direct` with base `/api`;
the empty bearer key fails `keyMatches` and `RequireAuth` falls through to the
session cookie; `/api/agents`, its models/skills routes, and attachment upload
are all registered on every role. Agents, models, skills, attachments: fine.

Its one real cost was `name: ''` leaving the composer's banners reading
"Reconnecting to " and "Claude Code is not installed on ". **Fixed** by giving
`HUB_MACHINE` the name `'this hub'`. **Unverified.**

### F7. Every SSH tab will create a thread nobody asked for — NOT STARTED

`SSHRightSidebar.tsx:139-144` mounts `SSHAgentChatPanel` unconditionally (the
column is `display:none`-hidden, not unmounted), and nothing it does is gated on
`visible`. Once F1 is fixed, every SSH terminal tab opens an agent socket, and
`hello` lazily auto-creates the thread row server-side. It also pulls the whole
Tiptap/ai-elements composer into the SSH route's eager chunk.

Fix: latch a `connect` prop from `visible` (true once opened) and thread it into
`AgentChatPane`; hide-not-unmount still preserves the socket across toggles.

### F8. Cosmetic

The SSH hero asks "What should we build in prod-web?" — wrong verb for a
server-ops chat.

### Verified clean by the frontend review

- **`TestAgentSmokeRealProcessReachesTheClient` is a pre-existing flake, not a
  regression** — reproduced on a clean `git archive 43632f6` tree under
  `-count=5`. HEAD only hits it more often because the package now runs ~38s
  instead of ~20s.
- Hide-not-unmount's third branch matches its two siblings exactly.
- Worktree chat is unchanged in effect: same `machineWsUrl(machine, '/agent')`
  routing, same header suffix, no `mentionSource` passed by any worktree caller.
- All four new test files are registered in the vitest allowlist — nothing runs
  silently. But `SSHAgentChatPanel.tsx` has no test at all.
- The mention route and param name are correct.
- Backend namespace routing is sound; tool routes are hub-only with matching
  `publicPaths` entries.
