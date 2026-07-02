# Real git branches for worktree creation, checkout, and conflict prevention

Date: 2026-07-02
Status: Approved, pending implementation plan

## Problem

Worktree creation, branch selection, and branch switching are currently fully
simulated:

- `SpawnDialog`'s "Base" field is free text defaulting to `"main"` — not
  validated against any real repository.
- `store.CreateWorktree` auto-generates a branch name (`feat/agent-<id>`) when
  left blank, with no uniqueness check against branches already in use by
  other active worktrees.
- No code anywhere in `backend/` shells out to `git`. The `"$ git worktree
  add ..."` line shown in a worktree's terminal preview is a hardcoded string
  pushed into the fake terminal log, not a command that ran.
- `WorktreeService.Delete` never cleans up a worktree's `.wt/<id>` directory
  on disk — since creation never made one either, this has been latent, but
  it means there is no real directory for anything to check out branches in.

This spec makes branch selection and worktree lifecycle operations real:
listing actual repository branches, creating actual `git worktree` checkouts
on disk, preventing two worktrees from checking out the same branch (a real
git constraint), and allowing a worktree's branch to be changed via a real
`git checkout`.

## Scope

Included:
1. Real branch listing for a project's repository.
2. Real `git worktree add` on worktree creation; real `git worktree remove`
   on deletion.
3. Conflict prevention: a branch already checked out by another active
   worktree in the same project cannot be selected again.
4. Real `git checkout` when a worktree's branch is edited, restricted to
   branches that already exist in the repository (no create-on-edit).

Out of scope (explicitly deferred, not part of this spec):
- Free-text/new-branch creation from the edit flow (edit only offers a
  dropdown of existing branches).
- Any UI for viewing diffs, merges, or PRs against the real repo (those
  buttons already exist as toast-only stubs and are untouched).
- Handling uncommitted changes gracefully beyond surfacing git's own error —
  if `git checkout` fails because the worktree has a dirty working tree, the
  error message from git is relayed to the client as-is; no automatic stash
  or force-checkout logic is added.

## Backend: `internal/git` package

New package wrapping `os/exec` calls to the `git` binary. All commands use
`exec.Command` with an argument slice (never a shell string), so there is no
shell-injection surface. Branch and base names are additionally validated
against the pattern `^[A-Za-z0-9._/-]+$` and rejected if they start with `-`,
to prevent a crafted branch name from being interpreted as a git flag.

```go
package git

func ListBranches(repoPath string) ([]string, error)
// git -C <repoPath> branch --format=%(refname:short)

func AddWorktree(repoPath, worktreePath, branch, base string) error
// git -C <repoPath> worktree add -b <branch> <worktreePath> <base>

func RemoveWorktree(repoPath, worktreePath string) error
// git -C <repoPath> worktree remove <worktreePath>

func Checkout(worktreePath, branch string) error
// git -C <worktreePath> checkout <branch>
```

Errors from these functions wrap the command's stderr output so callers can
surface a meaningful message (e.g. "branch already checked out at
../other-worktree") without leaking full file-system paths beyond what git
itself includes.

## Backend: new endpoint

`GET /api/projects/{id}/branches` → `string[]`

Handler resolves the project, calls `git.ListBranches(project.Path)`, returns
the list. Used by both the Spawn dialog (Base field) and the Edit drawer
(branch field, when editing an existing worktree).

## Backend: `WorktreeService.Create` (real creation)

Current signature takes `projectID, mode, branch, base, model, task`. New
flow:

1. Look up the project (needs its real filesystem `Path`).
2. If `mode == "branch"`: validate `base` is present in
   `git.ListBranches(project.Path)` — reject with a clear error if not.
3. Pre-flight conflict check: query existing worktrees for this project;
   if any active (non-deleted) worktree already has `branch` as its `Branch`,
   reject before touching git or the database. ("Active" excludes nothing
   currently, since worktrees are hard-deleted on Delete rather than
   soft-deleted — so this is just "any existing row for this project with
   that branch".)
4. Create the DB row via `store.CreateWorktree` (as today) to obtain the
   generated ID.
5. If `mode == "branch"`: run `git.AddWorktree(project.Path, project.Path +
   "/.wt/" + id, branch, base)`. If this fails, delete the just-created DB
   row and return the git error to the caller — the DB never ends up
   pointing at a worktree that doesn't exist on disk.
6. If `mode == "root"`: no git worktree is created — root mode already means
   "use the project's own directory," so there is nothing to add.

## Backend: `WorktreeService.Delete` (real cleanup)

Before deleting the DB row (as today), if the worktree is not root mode, run
`git.RemoveWorktree(project.Path, project.Path + "/.wt/" + id)`. This closes
the gap where deleted worktrees left orphaned directories and stale
`.git/worktrees/` registrations.

## Backend: branch checkout on edit

Editing a worktree's `branch` field to a different value than its current
`Branch` now means "check out a different existing branch," not "rename."
New validation in the patch path (`WorktreeService.Update`, or a small
wrapper it delegates to before calling `store.UpdateWorktree`):

1. If the new `branch` equals the current branch, no-op (nothing git-related
   happens; other patch fields still apply normally).
2. If the worktree's current `state` is `running` or `waiting`, reject —
   the UI must pause the worktree first. This matches the existing
   pause/resume state values already in `Worktree.State`.
3. Pre-flight conflict check, same rule as creation: reject if another
   active worktree in the same project already has this branch checked out.
4. Run `git.Checkout(worktreePath, newBranch)` where `worktreePath` is
   `project.Path` for root-mode worktrees or `project.Path + "/.wt/" + id`
   otherwise. On failure, return the git error and leave the DB row
   unchanged. On success, persist the new `branch` value via
   `store.UpdateWorktree` as today.

## Frontend

- `SpawnDialog.tsx`: Base field changes from a free-text `<Input>` to a
  `<Select>`, following the same pattern as the existing Agent/Model
  dropdowns, backed by a new `useProjectBranches(projectId)` query hook
  (`GET /api/projects/{id}/branches`). The Branch field (new branch name)
  remains free text — it is a name that does not exist yet, so it cannot be
  a dropdown of existing branches.
- `EditDrawer.tsx`: for `kind === 'worktree'`, the branch field (currently
  prefilled from `w.branch` into slot `a`) becomes the same kind of
  `<Select>`, populated via `useProjectBranches` resolved through the
  existing `projectOfWorktree` lookup. The control is disabled (with a short
  hint, e.g. "pause to change branch") when the worktree's `state` is
  `running` or `waiting`.
- Both selects show a loading state while branches are being fetched and an
  empty/error state if the project path isn't a valid git repository (the
  `GET .../branches` call fails) — consistent with the project's existing
  "every data surface must render explicit loading, error, and empty states"
  rule.

## Testing

`internal/git` package tests run against a real temporary git repository
created via `git init` + real commits/branches in test setup (`t.TempDir()`),
not a mocked git binary — consistent with how `terminal.KillSession` is
already tested via a real injected function rather than an interface mock.
Cover: listing branches on a fresh repo, adding and removing a worktree,
checking out an existing branch, and the failure path when checking out a
branch that's already in use by another worktree (real git error).

Service-level tests cover: conflict rejection before any git command runs,
rollback of the DB row when `git worktree add` fails, and the
running/waiting-state block on branch edit.
