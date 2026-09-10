// The desktop app's own updater. Implements decisions D1, D2 and D6 of
// `docs/superpowers/specs/2026-08-24-desktop-auto-update-design.md`.
//
// Scope: this owns the whole `.app`/`.exe`/`.AppImage`, sidecar included. It
// is deliberately separate from the Go runtime's selfupdate (`/api/self/update`),
// which owns a standalone runtime binary. The two never touch the same file.
//
// The check/download cycle is a MODULE-LEVEL SINGLETON, not per-component
// state. Two components consume it — the always-mounted `UpdateBanner` and
// `VersionSection`, which mounts whenever Settings → About is opened — and a
// per-instance hook would give each of them its own `check()`, its own
// `download()` of the full bundle, and its own 6-hour timer. Opening About
// would re-download the entire release every time.
import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import type { Update } from '@tauri-apps/plugin-updater'

/** D6: once on start, then every 6 hours for as long as the app stays open.
 *  Affordable here in a way `useMachineUpdateCheck` is not (D9 of the
 *  2026-07-30 spec): Tauri's `check()` fetches `latest.json`, a plain release
 *  asset off the CDN, not the 60-requests/hour GitHub API. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** The version committed in `tauri.conf.json`. Only CI ever replaces it, with
 *  the release tag, immediately before bundling (D4) — so a bundle still
 *  reporting this value was not built by the release pipeline. */
export const UNSTAMPED_BUNDLE_VERSION = '0.1.0'

/** An update whose payload is already downloaded and staged on disk. Nothing
 *  else is ever surfaced: the pill must not exist while a check or a download
 *  is in flight, or it would flicker on every launch. */
export interface StagedUpdate {
  version: string
  /** Release notes from `latest.json`, when the release carried any. */
  notes?: string
}

export interface DesktopUpdate {
  staged: StagedUpdate | null
  installing: boolean
  /** True while `check()` is in flight. Not for the pill (see `StagedUpdate`)
   *  — it exists so `VersionSection`, opened deliberately from Settings, can
   *  show the operator that something is happening instead of going quiet. */
  checking: boolean
  /** True from the moment a found update starts downloading until it is
   *  staged or the download fails. Same rationale as `checking`. */
  downloading: boolean
  /** Installs the staged payload and relaunches. Resolves (rather than
   *  throwing) on failure, having already surfaced a toast — the caller's job
   *  is only to keep the pill on screen so it can be retried. */
  install: () => Promise<void>
  /** Runs the same check the 6-hour timer runs, on demand — the "Check for
   *  updates" button in VersionSection. A no-op while a check or download is
   *  already in flight, so a click during the background timer's own run
   *  cannot start a second overlapping `download()` onto the same
   *  `readyUpdate` swap. */
  checkNow: () => Promise<void>
}

/** D6, as a pure predicate so it can be asserted directly.
 *
 *  The dev-build clause is not cosmetic. `tauri.conf.json` is pinned at
 *  `0.1.0` and only CI stamps the real tag into it (D4), so a dev build
 *  believes it is on 0.1.0 and would be offered "an update" on every single
 *  launch. */
export function shouldCheckForUpdates(isTauri: boolean, isDev: boolean): boolean {
  return isTauri && !isDev
}

/** The second half of the D6 dev guard, applied to what `check()` reports.
 *
 *  `import.meta.env.DEV` alone is not enough. `make dev-tauri-full` and
 *  `make e2e-tauri-smoke` both build the web UI with a PRODUCTION `vite build`
 *  (via `prepare-webui`), so `DEV` is false in them while the bundle is still
 *  the unstamped 0.1.0 — and neither `tauri.dev-full.conf.json` nor
 *  `tauri.e2e.conf.json` overrides `version` or the updater endpoint. Without
 *  this, both would quietly download the real published release and offer to
 *  install it over the developer's debug build. */
export function isUnstampedBuild(currentVersion: string): boolean {
  return currentVersion === UNSTAMPED_BUNDLE_VERSION
}

// ---- Singleton state -------------------------------------------------------

interface Snapshot {
  staged: StagedUpdate | null
  installing: boolean
  checking: boolean
  downloading: boolean
}

let snapshot: Snapshot = { staged: null, installing: false, checking: false, downloading: false }
// The live `Update` handle whose payload has been downloaded. Held outside
// React: it is an opaque Tauri `Resource` with a Rust-side lifetime (the
// downloaded bytes are retained in the Rust process until `close()`), and it
// must survive from the background download through to a much later click.
let readyUpdate: Update | null = null
let controllerStarted = false
let timer: ReturnType<typeof setInterval> | null = null
const subscribers = new Set<() => void>()

function emit(next: Snapshot) {
  snapshot = next
  for (const fn of subscribers) fn()
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}

function getSnapshot(): Snapshot {
  return snapshot
}

/** Releasing a Tauri `Resource` is best-effort by nature: the handle may
 *  already be gone, and failing to free bytes is never worth surfacing. */
async function closeQuietly(update: Update | null) {
  if (!update) return
  try {
    await update.close()
  } catch {
    // Already closed, or the app is shutting down. Nothing to do.
  }
}

async function runCheck() {
  // `checking`/`downloading` are read by VersionSection only — Settings is
  // opened deliberately, so surfacing them there does not create the
  // every-launch flicker the pill avoids by never rendering for either.
  emit({ ...snapshot, checking: true })
  let found: Update | null
  try {
    // Dynamically imported so no Tauri plugin code is pulled into the web
    // bundle, where none of it can work.
    const { check } = await import('@tauri-apps/plugin-updater')
    found = await check()
  } catch {
    // Silent by design: offline and an absent `latest.json` both land here,
    // and a background check the operator never asked for must not produce
    // noise. A *download* failure is different — see below.
    emit({ ...snapshot, checking: false })
    return
  }
  if (!found) {
    emit({ ...snapshot, checking: false })
    return
  }

  if (isUnstampedBuild(found.currentVersion)) {
    emit({ ...snapshot, checking: false })
    await closeQuietly(found)
    return
  }
  // Already staged. Without this the 6-hour tick re-downloads the identical
  // payload forever — `check()` keeps reporting it, since the INSTALLED
  // version is what it compares against and that does not change until the
  // operator restarts. A dashboard left open for a week would otherwise pull
  // the full bundle 28 times and retain every copy.
  if (readyUpdate && readyUpdate.version === found.version) {
    emit({ ...snapshot, checking: false })
    await closeQuietly(found)
    return
  }

  emit({ ...snapshot, checking: false, downloading: true })
  try {
    // D2: the download is silent and automatic; only the install needs
    // consent. `download()` stages the payload without touching the installed
    // app, so nothing is destroyed until the operator clicks.
    await found.download()
  } catch (e) {
    // Distinct from the check failure above, and deliberately loud: this is
    // where a rejected minisign signature lands. The payload can never become
    // installable (`readyUpdate` is not advanced), but a release whose
    // signature does not verify would otherwise strand every desktop install
    // on the old version with no signal at all.
    toast.error(`Update ${found.version} failed to download: ${e instanceof Error ? e.message : String(e)}`)
    emit({ ...snapshot, downloading: false })
    await closeQuietly(found)
    return
  }

  const previous = readyUpdate
  readyUpdate = found
  emit({ ...snapshot, downloading: false, staged: { version: found.version, notes: found.body } })
  // Only after the swap, so a failure to free the old one cannot strand the
  // new staged payload.
  await closeQuietly(previous)
}

/** Starts the one check loop for the process. Idempotent: every consumer calls
 *  it on mount, and all but the first are no-ops. Never torn down — checks
 *  belong to the app's lifetime, not to whichever component happens to be
 *  mounted. */
function startController() {
  if (controllerStarted) return
  if (!shouldCheckForUpdates('__TAURI_INTERNALS__' in window, import.meta.env.DEV)) return
  controllerStarted = true
  void runCheck()
  timer = setInterval(() => void runCheck(), CHECK_INTERVAL_MS)
}

async function install(): Promise<void> {
  const update = readyUpdate
  // The `installing` guard is what keeps two mounted consumers from firing
  // concurrent `plugin:updater|install` calls on the same staged payload.
  if (!update || snapshot.installing) return
  emit({ ...snapshot, installing: true })
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    // Stop the sidecar BEFORE the bundle is replaced. This cannot be left to
    // the app's `RunEvent::Exit` handler: on Windows the updater
    // `ShellExecuteW`s the installer and then calls `std::process::exit(0)`
    // directly, which never runs Tauri's event loop, so the sidecar is
    // orphaned — holding the SQLite file and the loopback port, and blocking
    // the installer from overwriting its own binary. See `prepare_for_update`
    // in src-tauri/src/lib.rs.
    await invoke('prepare_for_update')
    await update.install()
    // The JS `relaunch()` helper lives in `@tauri-apps/plugin-process`,
    // which is not a dependency of this app — only the Rust
    // `tauri-plugin-process` is registered, and `process:allow-restart` is
    // in `capabilities/default.json`. This is the exact IPC that helper
    // makes, so it avoids adding a package for one `invoke` call.
    //
    // Reached on macOS and Linux only: the Windows updater never returns from
    // `install()`, having exited the process itself.
    await invoke('plugin:process|restart')
  } catch (e) {
    toast.error(`Update failed to install: ${e instanceof Error ? e.message : String(e)}`)
    // `staged` is deliberately left alone: the pill stays put so the
    // operator can retry without waiting out another 6-hour check.
    emit({ ...snapshot, installing: false })
  }
}

/** The manual half of `checkNow` — see the `DesktopUpdate.checkNow` doc
 *  comment for the reentrancy guard's rationale. Reads `snapshot` directly
 *  rather than a hook's stale closure, so it stays correct even if the timer
 *  flips `checking`/`downloading` between render and click. */
async function checkNow(): Promise<void> {
  if (snapshot.checking || snapshot.downloading) return
  await runCheck()
}

/** Test seam. The controller is process-wide by design, which means it also
 *  outlives a single test — this puts the module back to its initial state. */
export function __resetDesktopUpdateForTests() {
  if (timer) clearInterval(timer)
  timer = null
  controllerStarted = false
  readyUpdate = null
  subscribers.clear()
  snapshot = { staged: null, installing: false, checking: false, downloading: false }
}

export function useDesktopUpdate(): DesktopUpdate {
  useEffect(() => {
    startController()
  }, [])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    staged: state.staged,
    installing: state.installing,
    checking: state.checking,
    downloading: state.downloading,
    install,
    checkNow,
  }
}
