# Sidebar Shell Explorer

**Date:** 2026-08-04
**Status:** design approved, pending implementation plan

## Problem

When a worktree or SSH shell tab is focused, the left sidebar panel keeps showing
the Projects tree. The file tree for the shell you are actually working in exists
only as a pane tab inside the tiling canvas (`PaneContent` kind `explorer`), which
means it competes with the terminal for the content area. Operators want the
VSCode arrangement: the file tree as persistent left-hand chrome, terminal owning
the full content area.

## Goal

While a shell tab (worktree or SSH) is focused, the 306px sidebar panel shows a
file explorer rooted at that shell's working directory instead of the Projects
tree. The swap follows tab focus automatically. The panel becomes drag-resizable.

## Non-goals

- The in-pane `explorer` pane tab stays exactly as it is. Both surfaces coexist;
  neither is deprecated and the `+` menu entry is untouched.
- `TerminalExplorer`'s tree rendering, context menu, drag-and-drop, upload, zip,
  and deps-dialog behaviour are unchanged. This spec only adds a second mount
  site and two optional controlled props.
- No change to routing. The sidebar reads focus state; it never navigates.

## Architecture

Five units, each independently testable.

### 1. `useActiveShellTarget` — which shell is focused

New file: `frontend/src/features/sidebar/useActiveShellTarget.ts`

```ts
export type ActiveShell =
  | { kind: 'worktree'; key: string; worktreeId: string; machine: Machine; rootLabel: string }
  | { kind: 'ssh'; key: string; connectionId: string; rootLabel: string }

export function useActiveShellTarget(): ActiveShell | null
```

`key` is the identity used everywhere downstream (command routing, expanded-state
bucket, React `key`): `wt:<worktreeId>` or `ssh:<connectionId>`. It matches the
store slice each shell's layout lives in.

Resolution, mirroring the derivation `useScope` already performs:

1. `workspaceTileLayouts[wsId]` → `findTileLeaf(root, focusedLeafId)` → the tab
   whose id equals the leaf's `activeTabId`.
2. `kind === 'worktree'` → look up the project and worktree in `useWorkspace(wsId)`,
   the machine in `useMachines()` (same lookup `ProjectTree.ProjectRow` does).
   `rootLabel` = project name, falling back to the worktree label.
   If the machine is missing, return `null` — `TerminalExplorer` cannot build a
   worktree target without one.
3. `kind === 'ssh-shell'` → `connectionId` from the tab; `rootLabel` = the
   connection's name from the SSH connections query, falling back to `'SSH'`.
4. `agents` / `browser` / no tab → `null`.
5. No tile layout for this workspace (web mode, non-Tauri) → fall back to
   `useScope().wtId`; resolve it the same way as step 2. No SSH fallback exists
   because SSH shells are tile-only.

The hook returns a referentially stable object (memoized on the identifying
fields), so consumers can depend on it in effects without churn.

### 2. `ShellExplorerPanel` — the sidebar mount site

New file: `frontend/src/features/sidebar/ShellExplorerPanel.tsx`

```tsx
<ShellExplorerPanel shell={activeShell} onBack={dismiss} />
```

Layout: a single-row back bar (`‹ Projects`, height 28px) above
`<TerminalExplorer/>`. No other chrome — `TerminalExplorer` already renders its
own 36px toolbar carrying `rootLabel` and the upload / zip / delete / new-folder /
new-file / deps buttons, and it already hides the deps button for `ssh` targets.

Props passed through:

| prop | worktree | ssh |
|---|---|---|
| `target` | `{ kind: 'worktree', machine, worktreeId }` | `{ kind: 'ssh', connectionId }` |
| `rootLabel` | `shell.rootLabel` | `shell.rootLabel` |
| `contentSearchShortcut` | `'Ctrl Shift F'` | omitted |
| `onOpenFile` / `onFileDeleted` / `onRequestQuickOpen` / `onRequestContentSearch` | dispatch a shell command (§3) | same |

Mounted with `key={shell.key}` so switching shells gets a clean instance rather
than a tree showing the previous shell's paths mid-fetch.

### 3. Shell command bridge — sidebar → pane

`TerminalExplorer`'s four callbacks all resolve to state owned by the pane
components: `ExpandedTerminal` holds `dirtyFiles`, `definitionReveals`,
`quickOpen`, `contentSearch`; `SSHShellPane` holds the same shape against
`sshTileLayouts`. Reimplementing `openFile` and `handleFilesDeleted` in the store
would duplicate that bookkeeping and let the two copies drift.

Instead the sidebar posts an intent and the already-mounted pane executes it with
the functions it already has.

Store addition (`frontend/src/store/useDevDeckStore.ts`):

```ts
type ShellCommandOp =
  | { kind: 'open-file'; path: string }
  | { kind: 'files-deleted'; paths: string[] }
  | { kind: 'quick-open' }
  | { kind: 'content-search' }

shellCommand: { targetKey: string; nonce: number; op: ShellCommandOp } | null
dispatchShellCommand: (targetKey: string, op: ShellCommandOp) => void   // increments nonce
```

`nonce` is a monotonically increasing counter, not a timestamp — it must be
replayable and must re-fire when the same op is issued twice in a row (deleting
two files one after the other, opening the same file twice).

`shellCommand` is **not persisted** (excluded in `partialize`): a queued intent
must never survive a reload and re-fire against a pane that has moved on.

Consumer side, identical in `ExpandedTerminal` and `SSHShellPane`:

```ts
useShellCommands(`wt:${worktree.id}`, {
  'open-file': ({ path }) => openFile(path),
  'files-deleted': ({ paths }) => handleFilesDeleted(paths),
  'quick-open': () => setQuickOpen(true),
  'content-search': () => setContentSearch(true),
})
```

`useShellCommands` (`frontend/src/features/terminal/useShellCommands.ts`) is a
`useEffect` keyed on `nonce` that no-ops unless `targetKey` matches. It reads the
handlers from a ref so a caller passing an inline object literal does not re-fire
the effect.

Safety: the sidebar only renders `ShellExplorerPanel` for the *focused* tab, and
the focused tab's pane is mounted by definition, so a dispatched command always
has a live consumer. If focus changes between dispatch and effect (not reachable
today, but cheap to guard), the mismatched `targetKey` drops it silently.

### 4. Sidebar mode switch

`frontend/src/features/sidebar/Sidebar.tsx`, replacing the current
`{view === 'ssh' ? <SSHGroupTree /> : <ProjectTree />}`:

```tsx
showExplorer
  ? <ShellExplorerPanel shell={activeShell} onBack={dismissExplorer} />
  : view === 'ssh' ? <SSHGroupTree /> : <ProjectTree />
```

`canExpandPanel` needs no change: a focused worktree tab already resolves to
`view === 'agents'` and a focused ssh-shell tab to `view === 'ssh'`, both of which
already permit the panel.

**Dismiss override.** Store field `explorerDismissedForShell: string | null`,
holding the `shell.key` the operator last dismissed. `showExplorer` is
`activeShell !== null && explorerDismissedForShell !== activeShell.key`.

`shell.key` is the right granularity because it is bijective with the tile-tab id:
a worktree tab's id *is* its `wtId` and an ssh-shell tab's id is
`ssh-<connectionId>` (see `createWorktreeTab` / `createSSHShellTab`), so keying on
the shell is keying on the tab without carrying a second identifier. The override
therefore evaporates the moment focus moves to a different shell — matching the
chosen "follows focus automatically" behaviour, with the back button as a
temporary escape rather than a mode. Not persisted.

**Expanded-state preservation.** `TerminalExplorer` holds its `expanded` path set
in local `useState`, so remounting per shell would collapse the tree on every tab
switch. Two optional controlled props are added:

```ts
expanded?: ReadonlySet<string>
onExpandedChange?: (next: ReadonlySet<string>) => void
```

When omitted the component keeps its current internal state, so the in-pane mount
site is byte-for-byte unaffected. The sidebar supplies them from a store slice
`shellExplorerExpanded: Record<string, string[]>` keyed by `shell.key` (persisted,
so a reopened shell restores its tree shape).

### 5. Resizable panel

Store: `sidebarPanelWidth: number` (persisted, default `306`), clamped to
`[240, 560]` on write so a corrupted or pre-existing persisted value cannot render
an unusable panel.

`Sidebar.tsx` applies it as an inline `style={{ width }}` on the `<aside>` in place
of the current `w-[306px]` class (the collapsed `w-[56px]` case is untouched), plus
a 4px drag strip absolutely positioned on the panel's right edge:

- `pointerdown` → `setPointerCapture`, record start x and start width
- `pointermove` → `setSidebarPanelWidth(startWidth + dx)` (the store clamps)
- `pointerup` → release capture
- `dblclick` → reset to `306`
- `cursor-col-resize`, `role="separator"`, `aria-orientation="vertical"`,
  and arrow-key adjustment for keyboard users

One width shared by both panel modes — a width that changed under you when you
switched tabs would read as a bug, not a feature.

## Data flow

```
focused tile tab ──useActiveShellTarget──► ActiveShell | null
                                                │
                              ┌─────────────────┴─────────────────┐
                        null │                                    │ shell
                             ▼                                    ▼
                   ProjectTree / SSHGroupTree            ShellExplorerPanel
                                                                  │
                                                          TerminalExplorer
                                                                  │ callbacks
                                                                  ▼
                                              dispatchShellCommand(key, op)
                                                                  │
                                                    useShellCommands(key, …)
                                                                  ▼
                                    ExpandedTerminal / SSHShellPane existing handlers
                                                                  │
                                              worktreeLayouts / sshTileLayouts
```

## Error and empty states

- **No shell focused** → Projects tree, exactly as today.
- **Worktree focused but machine unreachable or unassigned** → `useActiveShellTarget`
  returns `null` and the sidebar stays on Projects. `ProjectTree` already marks
  those worktrees unreachable and blocks opening them, so an explorer that could
  only ever show a fetch error is worse than no explorer.
- **File listing fails / is empty** → owned by `TerminalExplorer`, unchanged.
- **Dispatch with no matching consumer** → dropped silently. Not user-reachable
  in the current UI; the guard exists so a future background-tab explorer cannot
  corrupt a different shell's layout.

## Testing

| Unit | Test |
|---|---|
| `useActiveShellTarget` | worktree tab → worktree target; ssh-shell tab → ssh target; agents and browser tabs → `null`; worktree whose machine is missing → `null`; no tile layout → route-scope fallback |
| `dispatchShellCommand` | nonce strictly increases; two identical consecutive ops produce two distinct nonces; `shellCommand` absent from persisted state |
| `useShellCommands` | fires on matching `targetKey`; ignores mismatched key; does not re-fire when the handler object identity changes but `nonce` does not |
| dismiss override | dismiss hides the explorer for that shell; focusing a different shell clears it; refocusing the dismissed shell in the same session keeps it dismissed; absent from persisted state |
| `sidebarPanelWidth` | clamped at both bounds; double-click resets to 306 |
| `Sidebar` render | Projects ↔ Explorer swap follows the focused tab |

Existing `ExpandedTerminal` and `SSHShellPane` behaviour must be unchanged when
no command is dispatched — the in-pane explorer path is the regression risk.

## Implementation order

`frontend/src/store/useDevDeckStore.ts` is a convergence file (see
`ORCHESTRATION.md`) and carries four of the additions here — `shellCommand`,
`explorerDismissedForShell`, `shellExplorerExpanded`, `sidebarPanelWidth`. All store
changes land in one serialized step; nothing else may touch that file in parallel.

1. Store slice + `dispatchShellCommand` (serialized).
2. `useShellCommands` + wire into `ExpandedTerminal` and `SSHShellPane`.
3. `TerminalExplorer` optional controlled `expanded` props (default-preserving).
4. `useActiveShellTarget`.
5. `ShellExplorerPanel`.
6. `Sidebar` mode switch + dismiss button.
7. Resizable panel.

Verify with `npm run typecheck`, `npx vitest run`, `npm run build`.
