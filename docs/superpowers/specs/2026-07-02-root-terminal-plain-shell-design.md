# Root terminal = plain shell, no agent

## Problem

"Project root" spawn mode (`mode: 'root'`) is meant to be a quick-spawn terminal
in the project root — but it currently still behaves like an agent worktree
session: `SpawnDialog` requires picking an Agent + Model, and the backend
launches that agent binary as the PTY foreground process. There is no way to
just get a plain shell (zsh/bash/powershell) at the project root without also
starting an AI CLI.

## Goal

Root mode spawns a plain interactive shell — no Agent/Model selection, no AI
CLI process. Branch mode (agent working in a git worktree) is unchanged.

## Why this is a small change

The shell-fallback path already exists and works:

- `backend/internal/terminal/pty.go` `buildSessionCmd` runs `pickShell()`
  whenever `agentBin == ""`.
- `backend/internal/terminal/server.go` `resolveCommand` (lines 118-131)
  already leaves `agentBin == ""` when `wt.Model` doesn't match any known
  agent-ID prefix — including when `wt.Model` is empty.
- `resolveCommand` already resolves `workDir` to the project root for root
  worktrees (the `!wt.Root && wt.Branch != ""` branch-dir check is skipped).

So an empty `Model` on a root worktree **already** routes to a plain shell
today. The only thing stopping it is that the service force-defaults an empty
model to `"claude-sonnet-5"` before that check ever runs.

## Changes

1. **`backend/internal/service/worktree.go:29-32`** — only default
   `model → "claude-sonnet-5"` when `mode == "branch"`. For `mode == "root"`,
   leave `model` empty (no agent).

2. **`backend/internal/store/worktree.go:79-88`** — reword the seeded
   terminal lines for root mode. Current:
   ```
   "● starting agent in project root…"
   "reading task context…"
   ```
   New: drop the task-context line (root shells don't consume `Task`) and
   reword the status line to reflect a plain shell, e.g.
   `"✓ shell ready"` in place of `"● starting agent in project root…"`.

3. **`frontend/src/features/overlays/SpawnDialog.tsx`** — the Agent/Model
   picker (currently always rendered, lines 121-128) is hidden when
   `spawn.mode === 'root'`. The Task field is also hidden for root mode,
   since `resolveCommand` only reads `Task` to build agent `-p` args, which
   don't apply to a plain shell.

## Out of scope

- No new "session kind" field on `domain.Worktree` / `port.Store`. `Model`
  stays a plain `string`, empty for root sessions — no schema change.
- No change to `pty.go`, `resolveCommand`, or the `Root`/workDir logic —
  already correct once `Model` is empty.
- Branch mode (agent + git worktree) is untouched.
- These touch `frontend/src/store/types.ts` / `backend/internal/domain/models.go`
  not at all — avoids the CLAUDE.md convergence-file list, so no special
  serialization is needed for implementation.

## Testing

- Store/service unit test: `CreateWorktree(mode="root", model="")` yields a
  `Worktree` with `Model == ""` (not defaulted).
- Terminal integration: attaching to a root-mode session's PTY spawns
  `pickShell()`'s shell, not an agent binary.
- Frontend: SpawnDialog on the "Project root" tab shows no Agent/Model
  picker and no Task field; submits `model: ''`.
