# Desktop Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a gear icon to the desktop sidebar (Tauri + local-hub mode only) that opens a settings dialog for switching hub mode, checking Tailscale readiness, and opening the sidecar log.

**Architecture:** Pure frontend addition — no backend or Rust changes. A new `desktopBridge.ts` wraps the two Tauri commands that already exist (`change_hub`, `open_log_file`, both already ACL-permitted in `capabilities/default.json` via `hub-mode.toml`/`diagnostics.toml`). A new `desktopSettingsOpen` boolean in the zustand store drives a new `DesktopSettingsDialog`, registered in `GlobalOverlays.tsx`. A gear button in `Sidebar.tsx`, visible only when `useIsTauri() && isLoopbackHub`, opens it.

**Tech Stack:** React 19, zustand (immer + persist middleware), @tanstack/react-query (`useTailscaleStatus`), @base-ui/react Dialog wrapper (`components/ui/dialog.tsx`), Tauri v2 `invoke`, lucide-react icons, Tailwind v4, sonner (via store's `showToast`).

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-07-21-desktop-settings-panel-design.md` (approved).
- `@/*` path alias only — never relative imports into `src/`. (`.claude/rules/frontend.md`)
- `verbatimModuleSyntax` is on — use `import type` for type-only imports. (`.claude/rules/frontend.md`)
- No new backend/Rust/permissions changes — `change_hub` and `open_log_file` are already registered Tauri commands with ACL permissions granted (verified in `frontend/src-tauri/permissions/hub-mode.toml`, `diagnostics.toml`, `frontend/src-tauri/capabilities/default.json`).
- No dedicated component/store tests — this codebase has zero test files for dialogs, bridges, or store slices of this shape (`ConfirmDeleteDialog.tsx`, `MachineDialog.tsx`, `ConfirmMachineActionDialog.tsx`, `browserTilesBridge.ts` all have none). Verification is `cd frontend && npm run typecheck` plus a manual `make dev-tauri-full` smoke pass, matching this repo's established convention for this file category.
- Never edit `frontend/src/routeTree.gen.ts`.
- Toast errors via `err instanceof Error ? err.message : 'fallback message'`, matching every existing mutation error handler.

---

### Task 1: Store slice — `desktopSettingsOpen`

**Files:**
- Modify: `frontend/src/store/useDevDeckStore.ts:193` (state interface), `:254` (actions interface), `:409` (default state), `:477` (action impls)

**Interfaces:**
- Produces: `useDevDeckStore((s) => s.desktopSettingsOpen): boolean`, `useDevDeckStore((s) => s.openDesktopSettings): () => void`, `useDevDeckStore((s) => s.closeDesktopSettings): () => void`

- [ ] **Step 1: Add the state field**

In `frontend/src/store/useDevDeckStore.ts`, in the `DevDeckState` interface, right after `wsMenuOpen: boolean` (line 193):

```typescript
  wsMenuOpen: boolean
  /** Desktop settings dialog (Tauri + local hub only) — hub-mode switch,
   *  Tailscale status, sidecar log access. Not persisted, same as `wsMenuOpen`. */
  desktopSettingsOpen: boolean
```

- [ ] **Step 2: Add the actions to the interface**

Right after `closeWsMenu: () => void` (line 254):

```typescript
  toggleWsMenu: () => void
  closeWsMenu: () => void
  openDesktopSettings: () => void
  closeDesktopSettings: () => void
```

- [ ] **Step 3: Add the default state value**

Right after `wsMenuOpen: false,` (line 409):

```typescript
      sidebarOpen: false,
      wsMenuOpen: false,
      desktopSettingsOpen: false,
```

- [ ] **Step 4: Implement the actions**

Right after `closeWsMenu: () => set((s) => void (s.wsMenuOpen = false)),` (line 477):

```typescript
      toggleWsMenu: () => set((s) => void (s.wsMenuOpen = !s.wsMenuOpen)),
      closeWsMenu: () => set((s) => void (s.wsMenuOpen = false)),
      openDesktopSettings: () => set((s) => void (s.desktopSettingsOpen = true)),
      closeDesktopSettings: () => set((s) => void (s.desktopSettingsOpen = false)),
```

Do **not** add `desktopSettingsOpen` to the `partialize` block (~line 798) — it must not persist to localStorage, same as `wsMenuOpen`, `machineDialog`, and every other transient dialog boolean.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS, no new errors. (The new fields are unused until Task 3/4 wire them up, but TypeScript won't flag unused interface members or unused store actions — only unused local variables/imports — so this compiles clean on its own.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/store/useDevDeckStore.ts
git commit -m "feat(store): add desktopSettingsOpen dialog slice"
```

---

### Task 2: `desktopBridge.ts`

**Files:**
- Create: `frontend/src/features/desktop/desktopBridge.ts`

**Interfaces:**
- Produces: `changeHub(): Promise<void>`, `openLogFile(): Promise<void>`

- [ ] **Step 1: Write the bridge file**

```typescript
// Thin wrapper around this app's hub-mode/diagnostics Tauri commands
// (frontend/src-tauri/src/lib.rs). Desktop-only — every export here assumes
// useIsTauri() is already true; callers gate on that themselves, matching
// how browserTilesBridge.ts reaches into Tauri-only APIs.

import { invoke } from '@tauri-apps/api/core'

/** Clears the saved hub mode and restarts the app — it comes back up on the
 *  first-run hub-mode picker. See Rust's `change_hub` in `lib.rs`. */
export function changeHub(): Promise<void> {
  return invoke('change_hub')
}

/** Opens this device's sidecar.log with the OS's default handler. See
 *  Rust's `open_log_file` in `lib.rs`. */
export function openLogFile(): Promise<void> {
  return invoke('open_log_file')
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS. `@tauri-apps/api/core` is already a dependency (used identically by `browserTilesBridge.ts`), so no install step is needed.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/desktop/desktopBridge.ts
git commit -m "feat(desktop): add change_hub/open_log_file bridge wrapper"
```

---

### Task 3: `DesktopSettingsDialog` + register in `GlobalOverlays`

**Files:**
- Create: `frontend/src/features/overlays/DesktopSettingsDialog.tsx`
- Modify: `frontend/src/features/overlays/GlobalOverlays.tsx`

**Interfaces:**
- Consumes: `changeHub`, `openLogFile` from Task 2 (`@/features/desktop/desktopBridge`); `desktopSettingsOpen`, `openDesktopSettings`, `closeDesktopSettings`, `showToast` from Task 1's store slice; `useTailscaleStatus(enabled: boolean)` from `@/features/data/queries` (returns a `useQuery` result whose `.data` is `TailscaleHubStatus` from `@/lib/api`: `{ ready: boolean; reason?: 'not_installed' | 'not_ready' | 'serve_disabled'; url?: string }`); `Dialog`/`DialogTitle`/`DialogDescription` from `@/components/ui/dialog`; `Button` from `@/components/ui/button`; `StatusDot` from `@/components/ui/status-dot`.
- Produces: `DesktopSettingsDialog` component (default-exported as a named export, no props — reads everything from the store), registered as a sibling of `MachineDialog` in `GlobalOverlays`.

- [ ] **Step 1: Write the dialog component**

```tsx
import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { StatusDot } from '@/components/ui/status-dot'
import { changeHub, openLogFile } from '@/features/desktop/desktopBridge'
import { useTailscaleStatus } from '@/features/data/queries'
import type { TailscaleHubStatus } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'

function tailscaleLabel(status: TailscaleHubStatus | undefined, isLoading: boolean): { color: string; text: string } {
  if (isLoading || !status) return { color: '#6b7280', text: 'checking…' }
  if (status.ready) return { color: '#56d58a', text: status.url ?? 'ready' }
  if (status.reason === 'not_installed') return { color: '#f87171', text: "Tailscale isn't installed" }
  if (status.reason === 'not_ready') return { color: '#f87171', text: "Tailscale isn't signed in" }
  return { color: '#f87171', text: 'Restart DevDeck to expose this hub' }
}

export function DesktopSettingsDialog() {
  const open = useDevDeckStore((s) => s.desktopSettingsOpen)
  const close = useDevDeckStore((s) => s.closeDesktopSettings)
  const showToast = useDevDeckStore((s) => s.showToast)
  const tailscaleStatus = useTailscaleStatus(open)
  const [confirmingSwitch, setConfirmingSwitch] = useState(false)
  const [switching, setSwitching] = useState(false)

  function closeDialog() {
    setConfirmingSwitch(false)
    close()
  }

  function restartToPicker() {
    setSwitching(true)
    changeHub().catch((err) => {
      setSwitching(false)
      showToast(err instanceof Error ? err.message : 'Failed to switch hub mode')
    })
  }

  function onOpenLog() {
    openLogFile().catch((err) => showToast(err instanceof Error ? err.message : 'Failed to open log file'))
  }

  const label = tailscaleLabel(tailscaleStatus.data, tailscaleStatus.isLoading)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !switching && closeDialog()} width={440}>
      <DialogTitle>Desktop settings</DialogTitle>
      <DialogDescription className="mb-5">This device is hosting the hub locally.</DialogDescription>

      <div className="mb-5">
        <div className="mb-1.5 text-[12.5px] font-semibold text-devdeck-fg-2">Hub mode</div>
        {confirmingSwitch ? (
          <div className="rounded-lg border border-devdeck-border-card bg-devdeck-terminal p-3">
            <div className="mb-2 flex items-center gap-2">
              <TriangleAlert size={14} className="text-devdeck-yellow-soft" />
              <span className="font-mono text-[11px] text-devdeck-fg">DevDeck will restart immediately.</span>
            </div>
            <p className="mb-3 font-mono text-[10.5px] text-devdeck-dim-2">
              You&apos;ll be dropped back on the first-run hub picker. Any local sidecar this device is running
              stops too.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmingSwitch(false)} disabled={switching}>
                Cancel
              </Button>
              <Button variant="warning" size="sm" onClick={restartToPicker} disabled={switching}>
                Restart now
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-2 font-mono text-[11px] text-devdeck-dim-2">Hosting this hub locally on this device.</p>
            <Button variant="secondary" size="sm" onClick={() => setConfirmingSwitch(true)}>
              Switch to a remote hub…
            </Button>
          </>
        )}
      </div>

      <div className="mb-5">
        <div className="mb-1.5 text-[12.5px] font-semibold text-devdeck-fg-2">Tailscale</div>
        <span className="inline-flex items-center gap-2 font-mono text-[11px]" style={{ color: label.color }}>
          <StatusDot color={label.color} size={6} />
          {label.text}
        </span>
      </div>

      <div>
        <div className="mb-1.5 text-[12.5px] font-semibold text-devdeck-fg-2">Sidecar log</div>
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-devdeck-dim-2">sidecar.log for this device&apos;s local hub process.</p>
          <Button variant="secondary" size="sm" onClick={onOpenLog}>
            Open
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
```

- [ ] **Step 2: Register it in `GlobalOverlays.tsx`**

```tsx
import { SpawnDialog } from './SpawnDialog'
import { NewProjectDialog } from './NewProjectDialog'
import { NewWorkspaceDialog } from './NewWorkspaceDialog'
import { FolderBrowser } from './FolderBrowser'
import { EditDrawer } from './EditDrawer'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import { ConfirmMachineActionDialog } from './ConfirmMachineActionDialog'
import { TransferStatusPanel } from './TransferStatusPanel'
import { DesktopSettingsDialog } from './DesktopSettingsDialog'
import { MachineDialog } from '@/features/machines/MachineDialog'
import { SSHConnectionDialog } from '@/features/ssh/SSHConnectionDialog'
import { RenameSSHGroupDialog } from '@/features/ssh/RenameSSHGroupDialog'

/** All portal-rendered overlays, driven by the store's UI state. */
export function GlobalOverlays() {
  return (
    <>
      <SpawnDialog />
      <NewProjectDialog />
      <NewWorkspaceDialog />
      <FolderBrowser />
      <EditDrawer />
      <ConfirmDeleteDialog />
      <ConfirmMachineActionDialog />
      <TransferStatusPanel />
      <DesktopSettingsDialog />
      <MachineDialog />
      <SSHConnectionDialog />
      <RenameSSHGroupDialog />
    </>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS. If `TailscaleHubStatus` import errors as unused-type-only, confirm it's imported with `import type` (it is, in the snippet above) — `verbatimModuleSyntax` requires this.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/overlays/DesktopSettingsDialog.tsx frontend/src/features/overlays/GlobalOverlays.tsx
git commit -m "feat(desktop): add DesktopSettingsDialog with hub-mode/Tailscale/log sections"
```

---

### Task 4: Sidebar gear icon

**Files:**
- Modify: `frontend/src/features/sidebar/Sidebar.tsx`

**Interfaces:**
- Consumes: `openDesktopSettings` from Task 1's store slice; `useIsTauri` from `@/features/tabs/useIsTauri` (existing, no changes).

- [ ] **Step 1: Add imports**

```tsx
import { PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useIsTauri } from '@/features/tabs/useIsTauri'
import { useScope } from '@/features/useScope'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { Tooltip } from '@/components/ui/tooltip'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { SidebarNav } from './SidebarNav'
import { ProjectTree } from './ProjectTree'
import { SSHGroupTree } from './SSHGroupTree'
```

(This replaces the existing `import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'` line with the `Settings` icon added, and adds the `useIsTauri` import line.)

- [ ] **Step 2: Read the new store selector and compute visibility**

Inside `Sidebar`, right after the existing `toggleRailExpanded` selector line:

```tsx
  const sidebarOpen = useDevDeckStore((s) => s.sidebarOpen)
  const setSidebarOpen = useDevDeckStore((s) => s.setSidebarOpen)
  const railExpanded = useDevDeckStore((s) => s.railExpanded)
  const toggleRailExpanded = useDevDeckStore((s) => s.toggleRailExpanded)
  const openDesktopSettings = useDevDeckStore((s) => s.openDesktopSettings)
  const { view } = useScope()
  const canExpandPanel = view === 'agents' || view === 'ssh'
  const hasSidebarPanel = canExpandPanel && railExpanded
  const isLoopbackHub = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
  const showDesktopSettings = useIsTauri() && isLoopbackHub
```

- [ ] **Step 3: Render the gear button pinned to the bottom of the rail**

Change the rail's inner content div (currently ending right after `<SidebarNav compact />`) from:

```tsx
        <div className={cn('flex flex-none flex-col items-center bg-devdeck-surface py-2.5', hasSidebarPanel ? 'w-[56px] border-r border-devdeck-border' : 'w-full')}>
          {toggleButton ? (
            <div className="mb-1 flex flex-col items-center gap-1">
              {toggleButton ? (
                <Tooltip label={railExpanded ? 'Collapse sidebar' : 'Expand sidebar'} side="right">
                  {toggleButton}
                </Tooltip>
              ) : null}
            </div>
          ) : null}
          <WorkspaceSwitcher compact />
          <SidebarNav compact />
        </div>
```

to:

```tsx
        <div className={cn('flex flex-none flex-col items-center bg-devdeck-surface py-2.5', hasSidebarPanel ? 'w-[56px] border-r border-devdeck-border' : 'w-full')}>
          {toggleButton ? (
            <div className="mb-1 flex flex-col items-center gap-1">
              {toggleButton ? (
                <Tooltip label={railExpanded ? 'Collapse sidebar' : 'Expand sidebar'} side="right">
                  {toggleButton}
                </Tooltip>
              ) : null}
            </div>
          ) : null}
          <WorkspaceSwitcher compact />
          <SidebarNav compact />
          <div className="flex-1" />
          {showDesktopSettings ? (
            <Tooltip label="Desktop settings" side="right">
              <button
                type="button"
                onClick={openDesktopSettings}
                aria-label="Desktop settings"
                className={railControlClass}
              >
                <Settings size={16} />
              </button>
            </Tooltip>
          ) : null}
        </div>
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/sidebar/Sidebar.tsx
git commit -m "feat(sidebar): add desktop settings gear icon for local-hub Tauri mode"
```

---

### Task 5: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Full frontend build**

Run: `cd frontend && npm run build`
Expected: PASS, no type or bundling errors.

- [ ] **Step 2: Launch the desktop app in local-hub mode**

Run: `make dev-tauri-full`
Expected: App launches, first-run picker (if shown) → choose "Host locally".

- [ ] **Step 3: Confirm the gear icon appears and opens the dialog**

In the running app: confirm a gear icon is pinned to the bottom of the sidebar's icon rail. Click it — confirm the "Desktop settings" dialog opens showing three sections: Hub mode, Tailscale, Sidecar log.

- [ ] **Step 4: Confirm the gear icon is absent in a plain browser tab**

Open the same hub URL in a regular browser tab (not the Tauri window) — confirm no gear icon renders in that sidebar (the `useIsTauri()` gate should be `false` there).

- [ ] **Step 5: Exercise the Tailscale section**

Confirm the Tailscale section shows a colored status dot and label matching one of: `checking…` (gray), a resolved `https://…ts.net` URL (green, `ready`), or a red not-ready message. This should match whatever `MachineDialog`'s "Add runtime" flow shows for the same hub, since both read `useTailscaleStatus`.

- [ ] **Step 6: Exercise the sidecar log section**

Click "Open" under Sidecar log — confirm `sidecar.log` opens in the OS's default handler (e.g. Console.app or TextEdit on macOS) without any error toast.

- [ ] **Step 7: Exercise the hub-mode switch flow (careful — this restarts the app)**

Click "Switch to a remote hub…" — confirm it swaps in a yellow warning + Cancel/Restart now pair inline (no separate dialog). Click Cancel — confirm it reverts to the button. Click "Switch to a remote hub…" again, then "Restart now" — confirm the whole Tauri app restarts and lands on the first-run hub-mode picker within about a second.

- [ ] **Step 8: Re-pick "Host locally" to restore dev state**

On the first-run picker, choose "Host locally" again so the dev environment is back to its starting state for any further work this session.
