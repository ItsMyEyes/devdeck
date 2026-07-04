# CI/CD + Versioned Self-Update

## Goal
Add GitHub Actions CI/CD (unit tests, then build + release) and a `-updates`
flag on the `loom-api` binary that self-updates to the latest tagged release.
Self-update requires a version to compare against, so this also introduces
semver-tag-based versioning for the project.

## Versioning
- New package `backend/internal/version` exposing `var Version = "dev"`.
- `Makefile` computes `VERSION := $(shell git describe --tags --always --dirty
  2>/dev/null || echo dev)` and passes
  `-ldflags "-X loom/backend/internal/version.Version=$(VERSION)"` to every
  build target that produces `loom-api`/`loom-<os>-<arch>`
  (`build-api`, `portable-current`, `portable-all`).
- Releases are cut by pushing an annotated tag `vX.Y.Z` (semver). `git
  describe` on a tagged, clean commit resolves to exactly that tag, so the
  binary's embedded version matches the GitHub Release tag.
- New `-version` bool flag on `loom-api`: prints `Version` and exits 0. This
  is the "current version" `-updates` compares against, and is generally
  useful for support/debugging.

## CI/CD (GitHub Actions)
No CI exists today. Two workflows, both reusing existing `Makefile` targets
rather than reimplementing steps:

### `.github/workflows/test.yml`
- Triggers: `push` (any branch) and `pull_request` targeting `main`.
- Job `test`: checkout, setup Go (from `backend/go.mod`'s `go 1.25.0`), setup
  Node (from `frontend/package.json` — pin to Node 22 LTS), then:
  - `go vet ./...` (backend/)
  - `go test ./...` (backend/)
  - `npm ci` + `npm run typecheck` (frontend/) — frontend has no test runner
    configured today, so typecheck is its CI gate; out of scope to add one
    here.

### `.github/workflows/release.yml`
- Trigger: push of a tag matching `v*.*.*`.
- Job `release`: checkout (full history + tags, `fetch-depth: 0`, needed for
  `git describe` to resolve the pushed tag), setup Go + Node, re-run the same
  vet/test/typecheck gate as `test.yml` (a release must pass CI even if the
  tag was pushed from a branch that skipped it), then:
  - `make portable-all` — builds all 6 platform binaries
    (`loom-darwin-amd64`, `loom-darwin-arm64`, `loom-linux-amd64`,
    `loom-linux-arm64`, `loom-windows-amd64.exe`, `loom-windows-arm64.exe`)
    into `dist/`, with `VERSION` resolving to the pushed tag.
  - Create a GitHub Release for the tag and upload all 6 `dist/loom-*`
    binaries as release assets, via `softprops/action-gh-release` using the
    workflow's built-in `GITHUB_TOKEN` (sufficient — releasing to the same
    repo the workflow runs in, no extra PAT needed for this step).

## `-updates` flag (self-update)
New package `backend/internal/selfupdate`, wired into `main.go` as a `-updates`
bool flag that, when set, runs the update flow instead of starting the server
and then exits (like a subcommand).

- **Repo is hardcoded** to `ItsMyEyes/enginer-workspaces` (matches `git remote
  -v`). This isn't generic update infra — it's this app updating itself —so a
  configurable repo/owner is out of scope.
- **Auth**: `origin` is a **private** GitHub repo, so fetching release
  metadata and downloading assets both require an authenticated request. New
  flag `-github-token` (env `LOOM_GITHUB_TOKEN`), following the existing
  `envOr`-backed flag pattern (e.g. `--turnstile-secret-key`). Required only
  when `-updates` is passed; missing token → clear fatal error naming the
  flag/env var.
- **Version compare**: `golang.org/x/mod/semver` (official, zero-risk, single
  new go.mod line) compares the running `version.Version` against the
  release's `tag_name`.
  - If `version.Version == "dev"` (unreleased/local build): refuse with
    "can't check for updates from a dev build" — nothing meaningful to
    compare against.
  - If already on the latest tag: print `"already on latest version vX.Y.Z"`,
    exit 0.
- **Fetch flow**:
  1. `GET https://api.github.com/repos/ItsMyEyes/enginer-workspaces/releases/latest`
     with `Authorization: Bearer <token>` and
     `Accept: application/vnd.github+json`.
  2. Find the asset named `loom-{GOOS}-{GOARCH}` (`+".exe"` on Windows,
     matching the `portable-all` naming) in `assets[]`.
  3. Download it via the asset's API URL
     (`GET /repos/.../releases/assets/{id}` with
     `Accept: application/octet-stream` + the same bearer token — required
     for private repos; the plain `browser_download_url` doesn't work
     unauthenticated here).
- **Atomic replace**, written next to the current executable
  (`os.Executable()`'s directory, so the final swap is same-filesystem):
  - Download to a temp file in that directory, `chmod 0o755` (no-op on
    Windows).
  - Unix: `os.Rename(tmp, currentExePath)` — safe even while the current
    process is executing that file (the running process keeps its old inode
    open; the new file is what the next invocation sees).
  - Windows: can't overwrite a running `.exe`. Rename current exe to
    `<name>.exe.old` first, then rename the temp file into the vacated path.
    Best-effort `os.Remove` of the `.old` file after (ignored if it fails —
    e.g. still locked by the running process; harmless leftover, not
    cleaned up automatically since that's out of scope for this change).
- **No auto-restart.** Loom manages live terminal/PTY sessions; killing and
  re-exec'ing the process mid-session would drop them unexpectedly. After a
  successful swap, print `"updated to vX.Y.Z — restart loom to use it"` and
  exit 0. Restarting (manually, or via whatever process manager runs Loom) is
  the operator's call.

## Error handling
- Network/API failures (rate limit, no internet, bad token, 404 no releases
  yet): fatal error with the underlying message, no partial file left in
  place (write to temp, only rename on full successful download).
- No matching asset for the current `GOOS`/`GOARCH` in the release: fatal
  error naming the platform — happens if a release was cut without running
  `portable-all` for that platform combo.

## Out of scope
- Frontend unit tests (none exist; typecheck is the CI gate for `frontend/`).
- Configurable update source / arbitrary repo support.
- Auto-restart after update.
- Rollback tooling (the `.old` file on Windows is best-effort cleanup, not a
  restore mechanism).
- Code signing / checksum verification of downloaded release assets.
