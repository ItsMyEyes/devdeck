# Desktop Settings Panel — Design

**Date:** 2026-07-21
**Status:** Approved (brainstorming complete)

## Goal

The Tauri desktop shell has no in-app way to change hub mode, check Tailscale
readiness, or get to the sidecar log — all three exist today but are either
native-menu-only (`change_hub`) or buried behind the startup error screen
(`open_log_file`, added in the recent error-page fix). This project adds a
gear icon to the sidebar that opens a small settings dialog surfacing all
three, for the "Host locally" desktop case specifically.

## Decisions (from brainstorming)

1. **Desktop + local mode only.** The gear icon is not shown in a plain
   browser tab, and not shown when the desktop app is pointed at a remote
   hub — both because the settings inside (hub-mode switch, this device's
   Tailscale status, this device's sidecar log) only make sense for "this
   Tauri process is hosting the hub locally."
2. **Scope: hub mode + Tailscale status + log file access.** Three sections
   in one dialog, all backed by things that already exist — no new backend
   or Rust work.
3. **Reuse `change_hub`/`open_log_file` as-is.** No new Tauri commands. The
   panel is a UI surface for existing capability, not new capability.

## Architecture

Pure frontend addition — no backend or Rust changes.

```
Sidebar icon rail (frontend/src/features/sidebar/Sidebar.tsx)
  gear icon, shown when: useIsTauri() && isLoopbackHub
    └─ onClick → store.openDesktopSettings()

DesktopSettingsDialog (frontend/src/features/overlays/DesktopSettingsDialog.tsx)
  Hub mode section
    "Switch to a remote hub…" → confirm step → desktopBridge.changeHub()
      → invoke('change_hub') → Rust clears hub-mode.json, app.restart()
  Tailscale section
    useTailscaleStatus(open) → same /api/tailscale-status query
    MachineDialog.tsx already uses → read-only ready/reason/url display
  Sidecar log section
    "Open" button → desktopBridge.openLogFile() → invoke('open_log_file')
      → Rust resolves app log dir, opens sidecar.log with the OS default
      handler (built in the 2026-07-21 error-page fix)
```

## Components

- **`frontend/src/features/desktop/desktopBridge.ts`** (new) — thin wrapper
  around the two Tauri commands this panel calls, following the same
  "desktop-only, caller gates on `useIsTauri()`" convention
  `browserTilesBridge.ts` already establishes for browser-tile commands:
  ```ts
  export function changeHub(): Promise<void> {
    return invoke('change_hub')
  }
  export function openLogFile(): Promise<void> {
    return invoke('open_log_file')
  }
  ```
  Uses `invoke` from `@tauri-apps/api/core` (already a dependency, already
  used this exact way by `browserTilesBridge.ts` — no new packages).
- **`frontend/src/store/useDevDeckStore.ts`** (extend) — `desktopSettingsOpen:
  boolean`, `openDesktopSettings: () => void`, `closeDesktopSettings: () =>
  void`, mirroring the store's existing simple boolean-dialog-toggle shape.
- **`frontend/src/features/overlays/DesktopSettingsDialog.tsx`** (new) — the
  dialog itself: three sections as laid out above, registered in
  `GlobalOverlays.tsx`. Hub-mode switch is gated behind an inline confirm
  step (replaces the action button with a warning + Cancel/Restart-now pair)
  since `change_hub` restarts the whole app immediately and unprompted —
  same "warn before a disruptive action" precedent as the recent runtime
  restart/stop confirm dialog.
- **`frontend/src/features/sidebar/Sidebar.tsx`** (extend) — a gear button
  (lucide `Settings` icon) added to the icon column, pinned to the bottom
  via a flex spacer below `<SidebarNav compact />`, using the same
  `railControlClass` styling as the existing collapse/expand toggle button.
  Visibility: `useIsTauri() && isLoopbackHub`, where `isLoopbackHub` is the
  same one-line `window.location.hostname === '127.0.0.1' || ... ===
  'localhost'` check `MachineDialog.tsx` already inlines (not worth
  extracting for a second one-line use).

## Data flow

1. Gear icon click → `openDesktopSettings()` sets `desktopSettingsOpen =
   true` → dialog renders, `useTailscaleStatus(true)` fires.
2. Tailscale section renders `checking…` → `ready` (green, shows the
   resolved URL) or one of `not_installed`/`not_ready`/`serve_disabled`
   (red, matching `MachineHealth`-style status dot conventions already used
   in `MachinesModule.tsx`).
3. "Open" on the log section → `desktopBridge.openLogFile()` → OS opens
   `sidecar.log` in the default handler (e.g. Console.app/TextEdit on
   macOS) — fire-and-forget, no dialog state change; a toast on failure
   only (`err instanceof Error ? err.message : ...`, matching every other
   mutation error handler in this codebase).
4. "Switch to a remote hub…" → inline confirm swap → "Restart now" →
   `desktopBridge.changeHub()` → the whole Tauri app restarts to the
   first-run hub-mode picker within ~1s. No success toast needed (the
   restart itself is the visible confirmation); a failure toast if the
   `invoke()` call itself rejects before the restart happens.

## Error handling

- `changeHub()`/`openLogFile()` rejecting (should be rare — both are
  simple, already-proven Tauri commands) surfaces as a toast via
  `showToast(err instanceof Error ? err.message : 'fallback message')`,
  the same pattern used by every mutation error handler already in this
  codebase (see `ConfirmMachineActionDialog.tsx`, `ConfirmDeleteDialog.tsx`).
- Tailscale status query failure (network hiccup calling the hub's own
  `/api/tailscale-status`) falls back to a `checking…`-style neutral state
  rather than a hard error — matches `MachineDialog.tsx`'s existing
  tolerance for this exact query.

## Testing

- No new backend or Rust tests — nothing changes on those sides.
- Frontend: `npm run typecheck`, matching this codebase's existing
  convention of no dedicated component tests for dialogs (`ConfirmDeleteDialog.tsx`,
  `MachineDialog.tsx`, `ConfirmMachineActionDialog.tsx` — none have tests).
- Manual: `make dev-tauri-full`, confirm the gear icon appears (desktop +
  local), confirm it's absent in a plain browser tab pointed at the same
  hub, exercise all three sections including the restart-to-picker flow.

## Out of scope

- Any settings beyond these three (per Decision 2 — more can be added
  later as their own follow-up).
- A general, VS Code-style categorized settings browser — not what was
  asked for; this is a small, desktop-specific panel.
- Showing the gear icon for a remote-mode Tauri window, or in a plain
  browser tab (per Decision 1).
