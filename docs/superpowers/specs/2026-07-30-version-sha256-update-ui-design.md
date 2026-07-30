# Version, sha256 & Update UI

## Goal
Surface the running build's version and sha256 in the app, let the operator
check GitHub for a newer release, and install it from the UI — per machine,
not just from the `--updates` CLI flag that exists today.

Three surfaces, one mechanism:
- `DesktopSettingsDialog` — a "Version" section for the process this desktop
  hosts locally.
- The Machines page — a version chip per registered runtime, plus a check and
  an update action.
- The existing `selfupdate` package, extended rather than replaced.

## Background: what exists today
- `internal/version` exposes `var Version = "dev"`, overridden at build time
  via `-ldflags -X` from `git describe` (Makefile) / the pushed tag (release
  workflow).
- `internal/selfupdate` implements the whole update mechanism — GitHub client,
  asset picking, atomic binary replace — driven only by `main.go`'s `--updates`
  flag, which prints to stdout and exits.
- `.github/workflows/release.yml` publishes `devdeck-runtime-<goos>-<goarch>`
  binaries **and** a `checksums.txt` (`sha256sum devdeck-runtime-* >
  checksums.txt`, so lines are `<hex>  <name>`). Nothing in the Go code reads
  it yet — only the shell/PowerShell install scripts do.
- `/api/self/restart` and `/api/self/stop` already expose a runtime's own
  process lifecycle, gated by the normal auth middleware, with a `managed`
  flag that refuses actions an external supervisor owns.
- The hub reaches those via `machineclient.postSelf` +
  `MachineHandler.PostMachineRestart`, and the UI via
  `ConfirmMachineActionDialog` driven by the store's `MachineAction` union.

This design adds no new architecture. It extends each of those seams.

## Decisions

### D1 — New `/api/self/*` routes, not `/api/health`
`/api/health` is deliberately auth-exempt (allowlisted in `RequireKey` and
`RequireAuth`), because `machineclient.CheckHealth` polls it to drive status
badges. Putting version + sha256 there would publish this build's exact
fingerprint to any unauthenticated caller, which is a free CVE-matching hint.

So three new routes sit next to the existing self-lifecycle ones, behind the
same auth:

| Route | Response |
| --- | --- |
| `GET /api/self/version` | `{version, sha256}` |
| `GET /api/self/update-check` | `{current, latest, updateAvailable, checksumVerified, tokenConfigured, activeSessions, managed, warning}` |
| `POST /api/self/update` | `{status: "updated", version}` |

`GET /api/self/version` touches no network — it is cheap enough to fetch for
every row on the Machines page.

### D2 — The hub proxies per-machine, reusing the machineclient pattern
`GET /api/machines/{id}/version`, `GET /api/machines/{id}/update-check`, and
`POST /api/machines/{id}/update` mirror `PostMachineRestart` exactly: look the
machine up in the store, call its own `/api/self/*` with the machine's key,
surface failures as `502` with the target's `{"error":…}` message unwrapped by
the existing `extractErrorMessage`.

`machineclient` currently has only `postSelf`, which discards the response
body. This adds a `getSelf(ctx, m, action, out any) error` sibling that decodes
JSON into `out`. Both share the same timeout, auth header, and error-unwrapping
behavior.

The local machine works through this path too — its stored URL is its own
`http://127.0.0.1:<port>`, so the call loops back into the same process.

### D3 — sha256 is a lazy, cached self-hash
New `internal/version/selfhash.go`:

```go
func SelfSHA256() (string, error)  // hex digest of os.Executable()
```

Hashed behind a `sync.Once` and cached for the process lifetime. Two reasons
not to compute it at startup: a ~60MB binary costs ~100ms of boot time for a
value most runs never read, and boot is already the busiest phase.

Caching is not just an optimization — it is correct. A self-update replaces
the binary's directory entry; the running process keeps executing the old
inode. The cached digest therefore keeps describing the code actually running
until the operator restarts, which is exactly what the UI should report.

Errors (unreadable executable, `os.Executable` failure) surface as an empty
`sha256` field rather than failing the whole response; the UI renders
"unavailable".

### D4 — Verify the local binary against its own release
When the running version is a real tag (not `dev`), the update check also
fetches `GET /repos/{owner}/{repo}/releases/tags/{current}` and its
`checksums.txt` asset, then compares the expected digest for this platform's
asset name against `version.SelfSHA256()`:

- `match` — binary is byte-identical to what that release published
- `mismatch` — it is not; the UI shows this in warning color
- `unknown` — no tag, no such release, no `checksums.txt`, or the fetch failed

This costs one extra GitHub call per check and is skipped entirely on a `dev`
build. `checksumVerified: "unknown"` is a normal answer, never an error.

### D5 — The GitHub token is optional
`selfupdate.Client` currently sets `Authorization: Bearer ` unconditionally,
even when `Token` is empty — a malformed header on every request. The repo
(`ItsMyEyes/devdeck`) is public today, so checking and downloading work
perfectly well unauthenticated.

Change: skip the `Authorization` header entirely when `Token == ""`. Drop
`main.go`'s `log.Fatalf("--updates requires --github-token …")`.

The token stays exactly where it is — `--github-token`, `DEVDECK_GITHUB_TOKEN`,
or `updates.github_token` in `devdeck.yaml`, read per-process by the runtime
that will use it. It is never written to the store, never sent to the browser,
and never travels hub → runtime. `tokenConfigured` in the check response is a
bare boolean so the UI can say "token: not set" without ever seeing the value.

When GitHub answers 403 or 404, the error message names the likely cause:
*"repo may be private or rate-limited — set DEVDECK_GITHUB_TOKEN on that
machine"*.

### D6 — Downloads are verified before anything is overwritten
`selfupdate.Run` gains a checksum step between download and replace:

1. Fetch the latest release.
2. Pick this platform's binary asset **and** the `checksums.txt` asset.
3. Download both.
4. Parse `checksums.txt` for this asset's expected digest; compare against
   `sha256.Sum256(downloaded)`.
5. Only on match, `ReplaceSelf`.

A mismatch aborts with a clear error naming both digests. Nothing is written at
all: verification runs on the in-memory bytes, before `ReplaceSelf` is ever
called, so there is no temp file to clean up and the running binary is
untouched.

If the release has no `checksums.txt` at all, the update proceeds with a
warning rather than aborting. This matches `install.sh` and `install.ps1`,
which already treat a missing or unfetchable manifest as a warning (see
`scripts/test/install_ps_test.ps1`: "checksums.txt fetch failure warns instead
of aborting"). Diverging here would mean the same release is installable by
the install script but not by self-update. The warning rides in the response
so the UI shows it.

### D7 — A `--managed` process refuses to update itself
The desktop app's local machine is a Tauri **sidecar** — a Go binary bundled
inside the `.app`/`.msi`, built by `make prepare-sidecar`, supervised by the
desktop's respawn loop. Replacing it from inside would invalidate the macOS
bundle signature (Gatekeeper can then refuse to launch it) and race the
supervisor that owns its lifecycle.

`POST /api/self/update` therefore refuses with `409` when `managed`, exactly as
`PostStop` already does:

> this runtime is supervised by its desktop app — update it by installing a new
> desktop release

`GET /api/self/version` and `GET /api/self/update-check` still work and still
report honestly; only installing is blocked. `DesktopSettingsDialog` shows the
version, the sha256, and the check result, and replaces its update button with
that explanation.

Consequence, stated plainly: the desktop's local machine cannot be updated from
the UI. Only separately-launched runtimes can. Updating the desktop app itself
stays a manual installer download.

### D8 — Update and restart are one confirmed action, two calls
`'update'` joins `'restart'` and `'stop'` in the store's `MachineAction` union,
so `ConfirmMachineActionDialog` and all its plumbing are reused as-is. Its copy
names the target version and the number of terminals that will die:

> Updating "beta-01" to v1.5.0 restarts its runtime process. 3 active terminals
> on this machine will disconnect and reconnect once it's back.

With zero active sessions the terminal sentence is dropped rather than rendered
as "0 active terminals".

`activeSessions` comes from a new `terminal.ActiveSessionCount() int` in
`kill.go` — `len(activeRegistry.sessions)` under the mutex the registry already
holds, returning `0` when `activeRegistry` is nil, matching how `KillSession`
and `KillWorktreeSessions` already guard the same package var on a process that
never started a terminal server.

On confirm the frontend calls `POST …/update`, and on success `POST
…/restart`. Two calls rather than one combined endpoint, because the failure
modes differ: a failed swap must never trigger a restart, and a failed restart
still leaves the new binary correctly staged for the next one.

### D9 — Checks are on-demand; version chips are not
`GET /api/self/version` is local and cheap, so every Machines row fetches it
(React Query, long `staleTime` — the value cannot change without a restart).

`GET /api/self/update-check` hits GitHub. Polling it per machine on the health
interval (15s) would exhaust the unauthenticated 60 requests/hour limit almost
immediately. So it is `enabled: false` and fires only from an explicit **Check
for updates** button — one in `DesktopSettingsDialog` for the local process,
one in the Machines module header that fans out across all machines. The
"update available" badge appears only after a check has run.

## UI

**`DesktopSettingsDialog` — new "Version" section**, following the existing
section pattern (`text-[12.5px] font-semibold` label + `font-mono text-[11px]`
body):

```
Version
  v1.4.2
  a3f9c1d2…8e7b            [copy]
  ✓ matches release v1.4.2

  [ Check for updates ]
  → "v1.5.0 available"  |  "up to date"  |  "token: not set"
```

Managed process: the button is replaced by "Update via the desktop installer."

**Machines page — `MachineRow`**: a version chip beside the health dot, reusing
the `local` chip's styling. After a check finds a newer release, the chip
becomes a `Download`-icon button that opens the confirm dialog.

```
● online · 12ms   v1.4.2   [↻] [⏻] [⚙] [🗑]
```

Each surface renders explicit loading, error, and empty states, per the
frontend rules.

## Error handling
- **Machine unreachable / wrong key** — `502` from the hub proxy with
  `machineclient`'s existing message; the row shows the error inline, no toast
  storm.
- **GitHub unreachable, rate-limited, 403/404** — the check returns a `200`
  with an `error` string rather than failing the request, so a broken check on
  one machine does not blank the page. `403`/`404` name the token as the likely
  fix.
- **No asset for this GOOS/GOARCH** — existing `PickAsset` error, surfaced
  verbatim.
- **Checksum mismatch on download** — abort, nothing written, error names both
  digests.
- **`dev` build** — `NeedsUpdate` already rejects it; the UI shows "dev build —
  updates unavailable" rather than an error.
- **Managed process** — `409` with the supervisor explanation (D7).

## Testing
Go:
- `SelfSHA256` — known bytes hash correctly; cached across calls; a missing
  executable yields an error, not a panic.
- Checksum parsing — the `<hex>  <name>` format, a name absent from the
  manifest, a malformed line.
- `Client` — no `Authorization` header when `Token` is empty; header present
  when set.
- `Run` — installs on digest match; aborts and leaves the target untouched on
  mismatch; proceeds with a warning when `checksums.txt` is absent.
- Handlers — the three `/api/self/*` routes, including the `managed` 409; the
  three hub proxies, mirroring `TestPostMachineRestartCallsTheMachinesSelfRestart`
  (assert the path the target receives).

Frontend: `npm run typecheck`. There is no frontend test runner in this repo.

## Files
**Backend** — `internal/version/selfhash.go` (new), `internal/selfupdate/checksums.go`
(new), `internal/selfupdate/{github,run}.go`, `internal/handler/self.go`,
`internal/handler/machine.go`, `internal/machineclient/client.go`,
`internal/terminal/kill.go` (exported session count), `cmd/server/main.go`
(routes + optional token).

**Frontend** — `lib/api.ts`, `features/data/queries.ts`,
`features/overlays/DesktopSettingsDialog.tsx`,
`features/overlays/ConfirmMachineActionDialog.tsx`,
`features/machines/MachinesModule.tsx`, `store/useDevDeckStore.ts`.

`cmd/server/main.go` and `store/useDevDeckStore.ts` are convergence files per
`ORCHESTRATION.md` — they are edited once, in a single integration step, never
from parallel agents.

## Out of scope
- Background or scheduled update checks — every check is operator-initiated.
- Rollback UI. The Windows `.old` file stays best-effort cleanup, not a restore
  path.
- Self-update for the Tauri desktop bundle (`.dmg`/`.msi`/`.deb`) — that stays
  a manual installer download (D7).
- Signature or attestation verification beyond sha256.
- Making the update source configurable. `Owner`/`Repo` stay constants: this is
  the app updating itself, not generic update infrastructure.
