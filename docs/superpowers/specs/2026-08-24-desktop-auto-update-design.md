# Desktop Auto-Update

## Goal

Give the Tauri desktop app a real updater: it checks on its own, downloads in
the background, and installs on an explicit click that names what the restart
will destroy. Replaces today's dead end, where the About panel correctly
reports "v0.2.1 available" and then offers no way to get it.

## Background: why nothing updates today

Three independent reasons, all discovered in the current tree:

1. **The desktop bundle has no updater at all.** `tauri-plugin-updater` is
   absent from `frontend/src-tauri/Cargo.toml`, there is no `plugins.updater`
   block in `tauri.conf.json`, no signing keypair, and `.github/workflows/release.yml`
   publishes `.dmg`/`.msi`/`.AppImage` but no `latest.json`.
2. **The Go runtime refuses to update itself when supervised.**
   `SelfHandler.PostUpdate` (`backend/internal/handler/self.go`) returns `409`
   when `managed`. That is decision D7 of
   `2026-07-30-version-sha256-update-ui-design.md` and it stays correct: the
   sidecar lives inside the signed `.app` bundle, so overwriting it in place
   invalidates the bundle and races the desktop's respawn loop.
3. **Checks never run on their own.** `useMachineUpdateCheck`
   (`frontend/src/features/data/queries.ts`) is `enabled: false` — decision D9,
   because the unauthenticated GitHub **API** allows 60 requests/hour.

## Decisions

### D1 — Tauri owns the desktop; Go's selfupdate is untouched

Inside the desktop shell, "is there an update" comes from
`@tauri-apps/plugin-updater`'s `check()`. The Go `/api/self/update-check`,
`/api/self/update`, and the whole Machines-page update flow are left exactly
as they are, still serving separately-launched runtimes. The `managed` 409
stays.

The deciding factor is rate limits. D9 banned automatic checks because they hit
the GitHub **API**. Tauri's check fetches `latest.json`, a plain release
**asset** off the CDN — unauthenticated and effectively unmetered. So an
automatic per-launch check is legitimate here in a way it was not for the Go
path, and D9 is respected rather than overturned.

Consequence: the desktop has two update mechanisms, split by artifact. Tauri
updates the whole `.app`/`.exe`/`.AppImage` (sidecar included, since the
sidecar ships inside it). Go's selfupdate updates a standalone runtime binary.
They never both own the same file.

### D2 — Download automatically, install only on consent

`RunEvent::ExitRequested | RunEvent::Exit => kill_sidecar(handle)`
(`frontend/src-tauri/src/lib.rs:223`) means relaunching kills the sidecar,
which kills every PTY **and** every in-flight agent run on the local machine.
DevDeck deliberately never reaps detached PTYs, so this is real work lost.

Therefore: check and download run silently in the background; installing is
always an explicit click. The prompt states how many terminals and agent runs
will die, and when either count is non-zero the confirm step is required.

### D3 — A `busy` signal that counts agent runs, not just PTYs

`activeSessions` in the existing update-check response is
`terminal.ActiveSessionCount()` — PTY sessions only
(`backend/internal/terminal/kill.go:37`). An agent run with no attached
terminal is invisible to it, so "safe to restart?" is currently under-reported.

New endpoints:

| Route | Response |
| --- | --- |
| `GET /api/self/busy` | `{"terminals": n, "agentRuns": n}` |
| `GET /api/machines/{id}/busy` | same, hub-proxied |

`terminals` is `terminal.ActiveSessionCount()`. `agentRuns` counts threads in
the orchestration engine's read model whose `Status` is `ThreadRunning` or
`ThreadWaiting` (both mean a turn is in flight or blocked on the operator —
either way, killing the process loses it), skipping `Deleted` threads.

The hub proxy mirrors `GetMachineVersion` exactly (decision D2 of the
2026-07-30 spec): look the machine up, call its `/api/self/busy` via
`machineclient.getSelf`, surface failures as `502`.

**Wiring constraint:** `selfH` is constructed at `backend/cmd/server/main.go:404`
but `agentEngine` only at line 513. So the busy endpoint MUST NOT be a method
on the existing `SelfHandler` taking the engine at construction. Use a separate
`handler.BusyHandler` constructed after the engine, and make it tolerate a nil
engine by reporting `agentRuns: 0` — mirroring how `ActiveSessionCount()`
returns 0 on a process with no terminal registry.

### D4 — The app version must be stamped at build time

`frontend/src-tauri/tauri.conf.json` is pinned at `"version": "0.1.0"` and
nothing in the Makefile or CI writes the tag into it. The updater compares
`latest.json`'s `version` against that value, so as it stands every installed
app would believe it is on 0.1.0 forever and would re-offer the same update
immediately after installing it.

CI writes the tag (minus the leading `v`) into `tauri.conf.json` before
`tauri build`. Local/dev builds keep `0.1.0`; that is fine because the
automatic check is disabled in dev (D6).

### D5 — `latest.json` is assembled from per-platform fragments

The release workflow builds desktop bundles on three runners and then **renames**
them, which breaks the `<asset>.sig` name pairing. `latest.json` embeds
signature *content*, not filenames, so each platform job writes a small
fragment instead of relying on the merge job to glob:

```json
{ "platform": "darwin-aarch64",
  "signature": "<content of the .sig file>",
  "assetName": "devdeck-desktop-macos-aarch64.app.tar.gz" }
```

The `release` job merges the three fragments into `latest.json`:

```json
{ "version": "0.2.1",
  "notes": "<CHANGELOG section for this tag>",
  "pub_date": "<RFC3339>",
  "platforms": {
    "darwin-aarch64": { "signature": "...", "url": "https://github.com/ItsMyEyes/devdeck/releases/download/v0.2.1/devdeck-desktop-macos-aarch64.app.tar.gz" },
    "windows-x86_64": { "signature": "...", "url": ".../devdeck-desktop-windows-amd64-setup.exe" },
    "linux-x86_64":   { "signature": "...", "url": ".../devdeck-desktop-linux-amd64.AppImage" }
  } }
```

and uploads it as a release asset. A missing fragment is a hard error, not a
silently absent platform — a `latest.json` that omits a platform silently
strands every user on it.

Updater artifact sources, confirmed against Tauri v2 docs:

| Platform | Updater artifact | Signature |
| --- | --- | --- |
| macOS | `target/release/bundle/macos/DevDeck.app.tar.gz` | `.app.tar.gz.sig` |
| Linux | `target/release/bundle/appimage/*.AppImage` (the AppImage itself is reused) | `.AppImage.sig` |
| Windows | `target/release/bundle/nsis/*-setup.exe` | `-setup.exe.sig` |

The Linux `.AppImage` and the Windows `-setup.exe` are **already** uploaded by
the current workflow. Only macOS gains a new asset: the `.app.tar.gz`, which
must be uploaded alongside the existing `.dmg`.

`.deb`/`.rpm` users stay on manual installs — the Tauri updater does not
support them. This is a known, accepted gap.

### D6 — When the check runs

`check()` fires once on app start and then every 6 hours while the app stays
open. It is skipped entirely when:

- not inside the Tauri shell (`'__TAURI_INTERNALS__' in window` is false), and
- `import.meta.env.DEV` is true — a dev build reports version `0.1.0` and would
  otherwise offer an update on every launch.

### D7 — Signing keys

Public key, committed in `tauri.conf.json`:

```
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDY5OUYxM0MyQUFCNzlCRjMKUldUem03ZXF3aE9mYVNFTVJJT1MxRUx0dEZEck1MMUdHOE1DRU01L1VmWlhkRnB6VFlVbU5zbXYK
```

The private key and its password live only in GitHub Actions secrets,
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. They are
never committed, never logged, and never read by application code.

## UI

A pill fixed to the bottom-right, mounted from `GlobalOverlays`. It renders
**only** once an update is downloaded and staged — never during checking or
downloading, so it cannot flicker on launch.

```
┌────────────────────────────────────┐
│ ↑ v0.2.1 ready to install          │
│   3 terminals · 1 agent running    │
│   [ Restart & install ]   [ Later ]│
└────────────────────────────────────┘
```

- `TransferStatusPanel` already owns `fixed bottom-4 right-4 z-50`. The update
  pill must stack **above** it, not overlap it.
- "Later" hides the pill for that version only. The dismissal is keyed by
  version string in `localStorage`, so a newer release re-prompts. It is
  deliberately **not** put in `useDevDeckStore.ts` — that is a convergence file
  per `ORCHESTRATION.md`, and this state needs to outlive a reload anyway.
- With any terminals or agent runs live, "Restart & install" opens a confirm
  step naming the counts before proceeding.
- Install failure surfaces via `toast.error` and leaves the pill in place so it
  can be retried.

`VersionSection` (`frontend/src/features/overlays/VersionSection.tsx`) is
reconciled: inside the desktop shell it reports Tauri's state and offers the
same install action, replacing the current "Supervised by the desktop app —
update by installing a new desktop release." dead end. Outside the desktop it
is unchanged.

## Error handling

- **Endpoint unreachable / offline** — the check fails silently. No toast, no
  pill; a background check the operator never asked for must not produce noise.
- **Signature verification fails** — the plugin rejects the download. Surfaced
  as a toast, and no pill appears; a bad signature must never be installable.
- **Install fails** — `toast.error` with the message; the pill stays.
- **`/api/self/busy` unreachable** — the pill still renders and still installs,
  but shows no counts rather than blocking on them. Never let a failed
  advisory query prevent an update.
- **Nil agent engine** — `agentRuns: 0`, not an error (D3).

## Testing

TDD throughout: tests are written before the implementation they cover.

Go:
- `agentRuns` counts only `ThreadRunning` + `ThreadWaiting`, skips `Deleted`,
  returns 0 for an empty state and 0 for a nil engine.
- `GET /api/self/busy` response shape.
- `GET /api/machines/{id}/busy` proxies to the target's `/api/self/busy` —
  mirror `TestPostMachineRestartCallsTheMachinesSelfRestart`, asserting the
  path the target receives.

`latest.json` generator: fragment merge produces the documented shape; a
missing platform fragment is a hard error; the tag's `v` prefix is stripped
from `version`; URLs are built from tag + asset name.

Frontend (vitest — run it as `node_modules/.bin/vitest`, and note
`vite.config.ts` carries an explicit `test.include` list a new test file must
match):
- the pill renders only when an update is staged;
- "Later" hides it and a different version re-shows it;
- the busy counts render, and a failed busy query still renders the pill.

`npm run typecheck` and `go vet ./...` must both pass.

## Files

**Backend** — `internal/handler/busy.go` (new), `internal/handler/machine.go`,
`internal/agentcore/orchestration/engine.go` (add a count method),
`cmd/server/main.go` (routes — convergence file, integrated once).

**Desktop** — `frontend/src-tauri/Cargo.toml`, `src/lib.rs`,
`tauri.conf.json`, `capabilities/default.json`, `frontend/package.json`.

**Frontend** — `src/features/updates/useDesktopUpdate.ts` (new),
`src/features/updates/UpdateBanner.tsx` (new), tests,
`src/features/overlays/GlobalOverlays.tsx`,
`src/features/overlays/VersionSection.tsx`, `src/lib/api.ts`,
`src/features/data/queries.ts`.

**CI** — `.github/workflows/release.yml`, `scripts/gen-latest-json.mjs` (new).

`cmd/server/main.go` is a convergence file per `ORCHESTRATION.md` — edited in a
single integration step, never from parallel agents. `useDevDeckStore.ts` is
deliberately not touched at all.

## Amendments after review

Five defects found by review after the first implementation pass. Recorded here
because each changed a decision above, not just its code.

**A1 — The check cycle is a module-level singleton (amends D6).** `useDesktopUpdate`
was a per-component hook, and it has two consumers: the always-mounted
`UpdateBanner` and `VersionSection`, which mounts on every visit to Settings →
About. Each instance ran its own `check()`, its own `download()` of the full
bundle, and its own 6-hour timer, so opening About re-downloaded the entire
release. It is now one controller behind `useSyncExternalStore`.

**A2 — A staged version is never re-downloaded (amends D6).** `check()` compares
against the INSTALLED version, which does not change until the operator
restarts, so it reports the same update indefinitely. Each 6-hour tick
re-pulled the full payload and leaked the previous Tauri `Update` resource
(which retains the downloaded bytes in the Rust process until `close()`). Now
guarded on the staged version, and the superseded handle is closed.

**A3 — Unknown busy counts confirm rather than install (amends D2/D3).** The
counts were fetched once when the update staged and never refreshed — no
`refetchInterval`, and opening a terminal or starting an agent turn travels
over the WebSocket and invalidates nothing. An operator working inside the
window fires no refocus event either, so the counts stayed frozen at whatever
was true when the pill appeared and a restart killing five terminals read as
"nothing running". `useMachineBusy` now polls at 5s, and — separately —
**absent counts now require the confirm step**, because absence of evidence is
not evidence that nothing is running. A broken `/busy` still never blocks an
update; it costs a click.

**A4 — The sidecar is killed explicitly before install (amends D2).** On Windows
`tauri-plugin-updater`'s `install_inner` runs its `on_before_exit` hook,
`ShellExecuteW`s the NSIS installer, then calls `std::process::exit(0)`
directly (updater.rs:865 in 2.10.1). That bypasses Tauri's event loop, so the
`RunEvent::Exit` arm that calls `kill_sidecar` never runs and
`devdeck-server.exe` is orphaned — holding the SQLite file and the loopback
port, and blocking the installer from overwriting its own binary. The plugin's
`Builder` exposes no `on_before_exit`, so a `prepare_for_update` command
(`permissions/updater-prepare.toml`) is invoked from the frontend immediately
before `install()`. It matters on macOS and Linux too: the sidecar executes
from inside the bundle being replaced.

**A5 — `VERSION` is passed explicitly in CI (amends D4).** The stamp step edits a
TRACKED file, and `tauri build`'s `beforeBuildCommand` then runs
`make prepare-sidecar` from that now-dirty tree. The Makefile's
`git describe --tags --dirty` therefore yielded `<tag>-dirty`, which would be
baked into all three sidecars shipped inside every bundle — and
`selfupdate.NeedsUpdate` sorts a prerelease below its release, so those
runtimes would report an update available against their own tag forever. The
Makefile's `VERSION` is now `?=` and both release jobs pass the tag.

Additionally: a failed download (where a rejected minisign signature lands) now
raises a toast instead of sharing the check's silent catch; the D6 dev guard
also rejects the unstamped `0.1.0` bundle, since `make dev-tauri-full` and
`make e2e-tauri-smoke` build the web UI with a production `vite build` and so
have `import.meta.env.DEV === false`; and `scripts/gen-latest-json.test.mjs`
now runs in both `test.yml` and release's gating `test` job, having previously
run nowhere.

## Out of scope

- Apple codesigning and notarization. The app is unsigned today and stays so;
  the updater's minisign signature is a separate mechanism and works without it.
- `.deb`/`.rpm` auto-update (unsupported by the Tauri updater).
- Rollback to a previous version.
- Auto-update for standalone runtimes — Go's selfupdate already owns that.
- Any change to the Machines page update flow.
