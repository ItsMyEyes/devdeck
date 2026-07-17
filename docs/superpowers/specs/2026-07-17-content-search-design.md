# File & SSH Content Search (ripgrep/grep) — Design

**Date:** 2026-07-17
**Status:** Approved (brainstorming complete)

## Goal

The file explorer already has filename/path search (`WorktreeFileService.Search`,
`SSHFileService.Search`, surfaced via the Ctrl+P "Quick Open" dialog) but no way
to search *inside* file contents. This adds a grep-style content search, using
ripgrep when available and falling back to `grep`, for both of the explorer's
two data sources: worktrees (local hub-owned projects and remote
Machine-assigned projects — same code path, see Architecture) and saved SSH
connections. If ripgrep isn't installed on a target, the user is offered a
one-click install (downloaded from ripgrep's GitHub releases) before falling
back to `grep`.

## Decisions (from brainstorming)

1. **Install method: download the prebuilt ripgrep binary from GitHub
   releases**, not a system package manager. `apt`/`dnf` need sudo, which a
   non-interactive backend process can't supply; `brew` alone would leave
   Linux uncovered. A GitHub-release binary needs no elevated privileges and
   works uniformly across hub, runtime Machines, and (via upload over the
   already-open SFTP connection) SSH targets.
2. **Result depth: full match view.** Results are grouped by file, each match
   shows its line number and a text preview, and clicking a match opens the
   file with the cursor at that line — not just a flat list of files that
   contain a match.
3. **UI placement: a new dedicated "Search in Files" panel**, separate from
   the existing Ctrl+P filename Quick Open. The two have different result
   shapes (grouped line matches vs. a flat path list) and the existing
   component's keyboard-nav/rendering is built around the flat-list case.
4. **Ask frequency: ask once per target, remember the choice.** The first
   content search on a worktree-machine or SSH connection that's missing `rg`
   shows the install offer; the user's answer is remembered for that target
   so they aren't re-prompted on every search.
5. **Windows scope: supported for install, not for the fallback.** Ripgrep's
   GitHub releases include Windows binaries, so auto-install works there. But
   there's no reliable built-in `grep` on Windows, so if the user declines (or
   install fails) on a Windows target, content search stays unavailable until
   `rg` is installed — no grep fallback on that platform.

## Approaches considered

- **Package-manager install** (`brew`/`apt`/`dnf`) — rejected per decision 1.
- **Add a "content" tab to the existing `FileQuickOpen` modal** instead of a
  new panel — rejected: that component's state/keyboard-nav model is built
  around a flat file-path list; forcing grouped line-level results into it
  would be more invasive than building a sibling component.
- **SSH content search via SFTP walk + read-every-file** (mirroring how SSH
  filename search already works) — rejected: content search means reading
  full file bytes for every file in the tree over the network, which is far
  slower than one remote `rg`/`grep` invocation. The existing 6s SFTP-walk
  budget for filename search wouldn't be nearly enough for content search
  across a real repo.

## Architecture

Two independent search paths, since "Machine" and "SSH" are different things
in this codebase (`domain.Machine` is a separately-running Loom runtime
reached over HTTP with a shared key; `domain.SSHConnection` is an arbitrary
external host reached only via SSH/SFTP, running no Loom code at all):

- **Worktree content search** (covers both hub-local and remote-Machine
  projects with one implementation): a new sibling method next to the
  existing filename `Search` on `WorktreeFileService`/`WorktreeFileHandler`.
  That handler already runs *on whichever process owns the worktree* — the
  hub for local/unassigned projects, or the remote runtime process itself for
  Machine-assigned ones — and the hub's existing generic reverse proxy
  (`MachineProxyHandler`, mounted at `/api/machines/{id}/proxy/...`) forwards
  any route transparently. So adding the new route here gets remote-Machine
  support for free; no proxy-specific code is needed.
- **SSH content search**: needs a genuinely new capability. Today `sshmgr`
  only opens an interactive PTY shell (`Server.runShell`) or an SFTP session
  (`FilePool`) — there is no "run one command over SSH and capture output"
  primitive anywhere in the codebase. This design adds one.

## Backend: worktree content search (local + Machine)

- New `WorktreeFileService.Grep(worktreeID, query, opts)` method, sibling to
  the existing `Search` (filename) method, same package/file
  (`internal/service/worktree_file.go`).
- Detection: `detect.ResolveBinary("rg")` (already handles the
  GUI/service-process-doesn't-see-the-login-shell's-PATH problem via its
  fallback-dir + login-shell-PATH probing — the same helper `internal/lsp`
  already reuses for language-server binaries).
- If found: shell out to `rg --json` (machine-readable — gives
  file/line/column/text without hand-parsing plain-text output), passing
  `--glob '!DIR'` excludes for the same directories the filename search
  already skips (`.git`, `.wt`, `.codegraph`, `node_modules`, `dist`, `build`,
  `vendor`, `.next`), plus a per-search timeout via `context`.
- If not found: shell out to `grep -rn` with `--exclude-dir=DIR` for the same
  skip list, and `-I` (skip binary files — `rg` does this automatically).
- Route: `GET /api/worktrees/{id}/files/grep`
  - Query params: `query` (required), `regex` (bool, default false = literal
    match), `caseSensitive` (bool, default false), `includePattern`
    (optional glob, e.g. `*.go`).
  - Response:
    ```json
    {
      "engine": "ripgrep" | "grep",
      "rgAvailable": false,
      "truncated": false,
      "files": [
        { "path": "src/foo.go", "matches": [{ "line": 42, "column": 5, "text": "func foo() {" }] }
      ]
    }
    ```
  - Result caps (exact numbers are an implementation detail, not a design
    commitment): a max file count and max matches per file, in the same
    spirit as the existing `maxFileSearchResults = 200` for filename search,
    plus the context timeout above so a huge/slow tree can't hang a request —
    return whatever was found so far with `truncated: true`.
  - Symlinks are skipped, matching the existing filename-search walk.

## Backend: SSH content search

- New `sshmgr` primitive for pooled, non-interactive command execution —
  e.g. `WithSSHClient[T any](ctx, pool, connectionID, fn func(*ssh.Client) (T, error))`,
  a sibling to the existing `WithSFTPClient`, reusing the same cached
  `*ssh.Client` the `FilePool` already keeps warm per connection (today only
  its paired `*sftp.Client` is exposed to callers) rather than dialing a new
  connection per search keystroke.
- Detection: run `command -v rg` (POSIX-portable) over the new exec
  primitive; present + non-empty output + zero exit code means installed.
- If found: exec `rg --json <args>` remotely; parsed identically to the local
  path.
- If not found: exec `grep -rn` remotely (assumed present on essentially any
  SSH-reachable Unix host; a hard failure here surfaces as a normal search
  error).
- **Command construction safety**: user-supplied query/path/glob values are
  never interpolated directly into the SSH command string. The full argv is
  built as a Go `[]string`, then joined through a strict POSIX single-quote
  shell-escaper (wrap each argument in `'...'`, escaping embedded `'` as
  `'\''`) before being sent as the single command string SSH's exec model
  requires.
- Route: `GET /api/ssh/connections/{id}/files/grep` — same query params and
  response shape as the worktree route. Search root is the connection's SFTP
  home directory, matching how filename search already resolves it
  (`remoteAbsPath`).
- **Scope note:** SSH remote hosts are assumed POSIX (Linux/macOS), matching
  every other SSH feature in the codebase (the `uname -s -m` OS/arch probe
  below is POSIX-only). A Windows SSH remote host is out of scope for this
  feature — Windows support (decision 5) applies to the local hub/runtime
  Machine case only.

## Ripgrep auto-install

- New small package (e.g. `internal/rginstall`) providing:
  - `LatestRelease(ctx) (*Release, error)` — hits the public GitHub API
    (`api.github.com/repos/BurntSushi/ripgrep/releases/latest`); no token
    needed since the repo is public (unlike `internal/selfupdate`, which
    authenticates against Loom's own private release repo). Picks the asset
    matching a given `goos`/`goarch` by ripgrep's actual release-asset naming
    convention (e.g. `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`,
    `x86_64-pc-windows-msvc`).
  - `InstallLocal(ctx, goos, goarch) (binPath string, err error)` —
    downloads the tar.gz/zip, extracts the `rg`/`rg.exe` binary in memory,
    and atomically writes it to `~/.local/bin/rg[.exe]`, mirroring
    `internal/selfupdate/replace.go`'s temp-file → chmod +x → rename pattern
    (`~/.local/bin` is already one of `detect.ResolveBinary`'s fallback
    search dirs, so the very next `Grep` call picks it up with no extra
    server-side state to track).
  - `InstallOverSSH(ctx, pool, connectionID) error` — probes the remote
    OS/arch via `uname -s -m` over the new exec primitive, downloads +
    extracts the matching asset **on the hub** (reusing `InstallLocal`'s
    fetch logic), then writes the extracted binary to the remote host's
    `~/.local/bin/rg` over the *already-open* pooled SFTP client and marks it
    executable via `sftpClient.Chmod(path, 0o755)` — so a firewalled remote
    host never needs outbound internet access itself.
- Routes: `POST /api/worktrees/{id}/files/grep/install-ripgrep`,
  `POST /api/ssh/connections/{id}/files/grep/install-ripgrep`. No request
  body. Success response echoes `{ "installed": true, "version": "14.1.1" }`;
  failure (unsupported platform/arch, network error, permission error) uses
  the existing `{"error": "..."}` envelope with an actionable message,
  matching `ToolUnavailableError`'s "never leak raw subprocess/HTTP error
  detail beyond a short, safe message" convention from the Tools module.

## Frontend

- New `ContentSearchPanel` component (exact name is an implementation
  detail), driven by `FilesTarget` exactly like `TerminalExplorer` and
  `FileQuickOpen` already are. Entry point: a new toolbar button in
  `TerminalExplorer.tsx` (alongside the existing footer "Search files /
  folders" Quick Open button) plus a keybind (Ctrl+Shift+F, matching VS
  Code's convention) wired in `ExpandedTerminal.tsx` next to the existing
  Ctrl+P wiring.
- New query hook `useContentSearchTarget(target, query, options)` in
  `queries.ts`, branching on `target.kind` exactly like the existing
  `useFileSearchTarget`, calling new `grepWorktreeFiles`/`grepSSHFiles`
  client functions in `machineApi.ts`/`sshFileApi.ts`.
- Results render grouped by file (collapsible group per file, VS Code style),
  each match showing its line number and preview text with the query
  substring highlighted. Clicking a match opens the file and scrolls to /
  selects that line — `FileEditor.tsx`/`CodeFileEditor.tsx` gain a small,
  additive "open at line N" entry point; no change to the underlying
  read/write endpoints.
- **Install banner**: when a response has `rgAvailable: false` and this
  target's id isn't already in a small `localStorage`-persisted "dismissed"
  set, an inline banner appears above the results with **Install** (calls the
  install route, shows a spinner, then re-runs the search) and **Use grep**
  (adds the target id to the dismissed set; banner won't show again for that
  target). On a Windows target — where there's no grep fallback — the banner
  only offers **Install**; dismissing it is a no-op that does *not* suppress
  future prompts, since search genuinely doesn't work there until `rg` is
  installed.

## Error handling

- Search errors (invalid regex, remote command failure, timeout) surface as
  `sonner` toasts via the existing `ApiError` pattern, matching
  `TerminalExplorer.tsx`/`FileQuickOpen.tsx` conventions. No change to the
  `{"error":"message"}` envelope.
- Install failures return a structured error (network error, unsupported
  platform/arch, permission error writing to `~/.local/bin` or over SFTP)
  with an actionable message; the frontend shows it as a toast and leaves the
  banner up so the user can retry.
- Subprocess/HTTP error detail is never leaked beyond a short, safe first
  line — matching the existing Tools-module convention
  (`writeToolErr`/`firstLine` in `internal/handler/tools.go`).

## Testing

- **Backend:** `skipIfMissing(t, "rg")` / `skipIfMissing(t, "grep")`
  real-subprocess tests for both engines' output parsing (mirroring
  `internal/service/tools_test.go`'s pattern); regex/literal/case-sensitivity
  coverage added to `worktree_file_test.go`; a new `ssh_file_test.go`
  (doesn't exist today) built on `sshmgr/testserver_test.go`'s in-process SSH
  server, covering both the new exec primitive and SSH-side `Grep`;
  install-flow tests against an `httptest.Server` standing in for the GitHub
  API (no real network calls in tests).
- **Frontend:** unit tests for the query-hook's target-dispatch branching
  (worktree vs. ssh) and the per-target dismissed-banner `localStorage`
  logic; a component test covering the install banner's three states
  (not-installed, installing, installed).

## Build order (for the implementation plan)

1. `sshmgr` exec primitive (`WithSSHClient`, pooled command execution) —
   foundation for everything SSH-side.
2. `WorktreeFileService.Grep` (ripgrep-only path first, detected via
   `detect.ResolveBinary`) + route + tests — proves the response shape
   end-to-end on the simpler (local) case first.
3. `SSHFileService.Grep`, reusing the same response types, built on step 1.
4. Grep fallback path (both worktree and SSH) for when `rg` is absent.
5. `internal/rginstall` package + the two install routes.
6. Frontend: query hooks + `ContentSearchPanel` UI + toolbar/keybind entry
   point + open-file-at-line wiring.
7. Frontend: install banner + per-target dismissed-state persistence.
