# Per-Tab Shell Sidebar

**Date:** 2026-08-04
**Status:** design approved, pending implementation plan
**Revises:** the first draft of this file (commit `b57615b`), which put a single
explorer in the app-level sidebar. See [Superseded approach](#superseded-approach).

## Problem

The file tree for the shell you are working in exists only as a pane tab inside
the tiling canvas (`PaneContent` kind `explorer`), so it competes with the
terminal for the content area. And with two shells open side by side there is no
way to see both trees at once, let alone move a file from one to the other —
today that means download to the laptop, then upload to the other host.

## Goal

Every shell tab — worktree or SSH — owns a left sidebar inside its own pane. Two
shells split side by side show two independent sidebars, each rooted at its own
filesystem. Each sidebar carries an Explorer and (for worktrees) a Git panel,
selected from a VSCode-style icon rail. Files and folders drag from one sidebar
to the other, transferring across worktrees, machines, and SSH hosts. The sidebar
toggles from a button at the far left of the pane header and from Cmd/Ctrl+B.

## Non-goals

- The app-level Projects sidebar (`features/sidebar/Sidebar.tsx`) is untouched.
- The in-pane `explorer` and `git` pane tabs stay exactly as they are. Both
  surfaces coexist; the `+` menu is unchanged.
- `TerminalExplorer` and `GitPanel` are not modified. This spec adds a second
  mount site for each and nothing more.
- SSH shells get no Git panel — `GitPanel` requires a worktree id and a machine,
  and there is no SSH-side git support to expose.

## Superseded approach

The first draft swapped the app-level 306px sidebar between the Projects tree and
an explorer that followed the focused tab. One sidebar cannot be two shells'
sidebars at once, so that design cannot satisfy the goal above and is dropped
whole: `useActiveShellTarget`, `ShellExplorerPanel`, the `shellCommand` store
bridge, the dismiss override, and the app-sidebar mode switch are all gone.

The replacement is strictly smaller. Because the sidebar now lives *inside*
`ExpandedTerminal` / `SSHShellPane`, it is a sibling of the `PaneCanvas` that
already owns the target, `openFile`, the dirty-file bookkeeping, and the
quick-open / content-search dialogs. Every callback `TerminalExplorer` needs is
already in scope. No cross-component bridge exists to build, and no controlled
`expanded` prop is needed either — backgrounded tile tabs are `display:none`'d
rather than unmounted, so tree state survives tab switching on its own.

## Architecture

### 1. `ShellSidebar`

New file: `frontend/src/features/terminal/ShellSidebar.tsx`

```tsx
interface ShellSidebarProps {
  shellKey: string                                   // 'wt:<id>' | 'ssh:<id>'
  target: FilesTarget
  rootLabel: string
  git?: { worktreeId: string; machine: Machine }     // omitted for SSH
  onOpenFile: (path: string) => void
  onFileDeleted: (paths: string[]) => void
  onRequestQuickOpen: () => void
  onRequestContentSearch: () => void
  contentSearchShortcut?: string
}
```

Layout: a 40px icon rail, the panel, and a 4px drag strip on the right edge.

The rail holds one button per panel — `Files` for Explorer, `GitBranch` for Git —
with the active one marked. The Git button is absent when `git` is undefined, so
an SSH sidebar shows a single-entry rail rather than a disabled control for a
capability that does not exist.

The panel body renders `<TerminalExplorer {...} />` or
`<GitPanel worktreeId machine active={open && panel === 'git'} />`, both
unmodified. Open state, selected panel, and width are read from the store by
`shellKey` (§3); the component holds no state of its own.

**Closing hides, it does not unmount.** A closed sidebar renders with
`display: none` rather than being torn down, so the explorer's expanded-path set
and scroll position survive a toggle — the same reason `TileLeafView` hides
backgrounded tabs instead of unmounting them. Unmounting would make Cmd/Ctrl+B
quietly destructive.

Drag strip behaviour: `pointerdown` captures the pointer and records start x and
width, `pointermove` writes `setShellSidebarWidth`, `pointerup` releases,
`dblclick` resets to the default. `role="separator"`, `aria-orientation="vertical"`,
and arrow-key adjustment for keyboard users.

### 2. Mount sites

`ExpandedTerminal` and `SSHShellPane` each wrap their existing body in a flex row:

```tsx
<div className="flex min-h-0 flex-1">
  <ShellSidebar shellKey={shellKey} … />   {/* self-hiding, see §1 */}
  <div className="flex min-w-0 flex-1 flex-col">
    <PaneCanvas … />
    {/* MobileKeyToolbar, FileQuickOpen, ContentSearchPanel, dialogs — unchanged */}
  </div>
</div>
```

The four callbacks are the *same function references* already handed to
`renderers.explorer`: `openFile`, `handleFilesDeleted`, `() => setQuickOpen(true)`,
`() => setContentSearch(true)`. `SSHShellPane` passes no `git` and no
`contentSearchShortcut`, matching what it passes its in-pane explorer today.

### 3. Sidebar state

Store addition (`frontend/src/store/useDevDeckStore.ts`):

```ts
shellSidebars: Record<string, { open: boolean; panel: 'explorer' | 'git'; width: number }>
setShellSidebarOpen:  (shellKey: string, open: boolean) => void
setShellSidebarPanel: (shellKey: string, panel: 'explorer' | 'git') => void
setShellSidebarWidth: (shellKey: string, width: number) => void
```

Keyed by `shellKey` (`wt:<worktreeId>` / `ssh:<connectionId>`), persisted.
Defaults for an unseen shell: `{ open: true, panel: 'explorer', width: 280 }`.
Width is clamped to `[200, 560]` **on write**, so a corrupted or hand-edited
persisted value cannot produce an unusable panel.

Open-by-default is a deliberate trade: existing shells lose ~320px of terminal
width on first launch after the update, in exchange for the feature being visible
without knowing the shortcut. Each shell remembers its own state from then on.

### 4. Toggle button

`PanelHeader` gains one prop, keeping it presentational as its doc comment
requires:

```ts
/** Rendered flush-left, before the tab strip. Used for the shell sidebar toggle. */
leadingContent?: ReactNode
```

`PaneCanvas` gains `paneLeadingContent?: (pane: LeafPane) => ReactNode`, the exact
shape of the existing `paneOverflowActions` / `paneNewTabActions` render props.

The shell pane returns the toggle **only for the first leaf in document order**,
so a split shows exactly one toggle and it sits adjacent to the sidebar it
controls. (`paneTree.ts` needs a `firstLeafId` helper if it lacks one;
`tileTree.ts` already has the equivalent.)

Icon: `PanelLeftClose` / `PanelLeftOpen`, already used by the app sidebar rail.
Tooltip reads "Toggle sidebar (⌘B)" or "(Ctrl+B)" by platform.

### 5. Cmd/Ctrl+B

Both `ExpandedTerminal` and `SSHShellPane` already run a window-level `keydown`
handler gated on their `isFocused` prop — the same mechanism that keeps Ctrl+P
from opening quick-open in both tiles of a split. Cmd/Ctrl+B is one more branch in
that existing handler and needs no new registry.

`preventDefault()` runs before xterm.js sees the key, on every platform. This
shadows the tmux prefix and readline's backward-char inside DevDeck terminals on
Windows and Linux. That cost was raised and the uniform binding was chosen
deliberately; it is not an oversight. If it turns out to bite, the escape hatch is
to make the binding configurable rather than to change the default.

### 6. Cross-shell drag-and-drop transfer

`TerminalExplorer` already emits an internal drag payload under `ENTRY_DRAG_MIME`
carrying the dragged paths. The payload is extended to identify its origin:

```ts
{ shellKey: string; paths: string[]; hasDir: boolean }
```

On drop, the receiving tree compares `shellKey` to its own:

- **Same shell** → the existing move-within-tree path. Unchanged.
- **Different shell** → a transfer, routed to a new
  `frontend/src/features/terminal/shellTransfer.ts`.

Both sidebars live in the same document (a split is two tile leaves in one
window, not two OS windows), so `dataTransfer` carries the payload natively.

Transfer routing:

| Selection | Route |
|---|---|
| files only | per file: `downloadFile(path, name)` → `new File([blob], name)` → `uploadFiles(destFolder, [file])` |
| contains a folder | `downloadZip(paths, name)` on the source → `POST …/files/extract` (multipart) on the destination |

Both primitives already exist for **both** target kinds in `useFileTransfers`.
Only `extract` is new (§7). The zip route sends the archive as the request body
and extracts server-side — no temp artifact is written to the destination, so a
failed transfer leaves nothing to clean up.

Progress reuses the store's existing transfer slice (`startTransfer` /
`updateTransferProgress` / `finishTransfer`), so cross-shell transfers appear in
the same UI as uploads and downloads. On settle, the file queries for **both**
source and destination are invalidated.

Bytes route through the browser. For a multi-gigabyte tree that is the wrong
shape, and a server-to-server relay would be the fix; that is out of scope here
and worth revisiting if it becomes a real complaint.

### 7. Backend: extract endpoints

Two new routes, mirroring the existing symmetric pairs:

```
POST /api/worktrees/{id}/files/extract
POST /api/ssh/connections/{id}/files/extract
```

Multipart, same shape as `Upload`: an `archive` file part and a `path` field
naming the destination folder. Service methods
`Extract(ctx, id, destFolder string, r io.Reader) ([]FileEntry, error)`, the
inverse of the existing `Archive`.

- **Worktree**: `archive/zip` over the received bytes, writing each entry beneath
  the resolved destination.
- **SSH**: the same decode in Go, writing each entry over the existing SFTP
  path — no dependency on an `unzip` binary being present on the remote host.

Security, and the reason this endpoint gets the most test attention:

- **Zip-slip guard.** Reject any entry whose cleaned path escapes the
  destination: `..` segments, absolute paths, and paths that resolve outside the
  root after cleaning. Rejection fails the whole request rather than skipping the
  entry, so a partially-extracted malicious archive is not a reachable state.
- **Symlink entries are rejected**, not followed.
- **Budget caps** on entry count and total uncompressed size, rejecting zip bombs
  before writing anything.

Responses use the standard `{"error": "message"}` envelope and `handleStoreErr`
for store errors, per `CONTRACTS.md`.

## Data flow

```
 ExpandedTerminal (worktree tab)          ExpandedTerminal (other worktree tab)
 ┌──────────────────────────────┐         ┌──────────────────────────────┐
 │ ShellSidebar   │ PaneCanvas  │         │ ShellSidebar   │ PaneCanvas  │
 │ ▪ rail 40px    │ ┌─────────┐ │         │ ▪ rail 40px    │ ┌─────────┐ │
 │   📄 Explorer  │ │PanelHdr │ │         │   📄 Explorer  │ │PanelHdr │ │
 │   ⎇  Git       │ │[◨]Term ×│ │         │   ⎇  Git       │ │[◨]Term ×│ │
 │ ▪ TerminalExpl │ │         │ │         │ ▪ TerminalExpl │ │         │ │
 │      │         │ │Terminal │ │         │      ▲         │ │Terminal │ │
 └──────┼─────────┴─┴─────────┘─┘         └──────┼─────────┴─┴─────────┘─┘
        │                                        │
        └────── drag: {shellKey, paths} ─────────┘
                          │
                  shellKey differs
                          ▼
                   shellTransfer.ts
              files → download + upload
              folders → zip + POST extract
```

## Error and empty states

- **SSH shell** → no Git entry in the rail at all.
- **Drop onto the same shell** → ordinary move, unchanged.
- **Drop of OS files onto a sidebar** → existing upload path, unchanged.
- **Partial transfer failure** → toast naming the failed count; both trees
  invalidated so the UI resyncs to whatever actually landed.
- **Extract rejected** (zip-slip, oversize) → error toast carrying the server
  message; nothing written on the destination.
- **Shell unreachable / listing fails** → `TerminalExplorer`'s existing error
  state, unchanged.
- **Sidebar width dragged to a bound** → clamps silently, no error.

## Testing

**Frontend**

| Unit | Test |
|---|---|
| `shellSidebars` slice | defaults for an unseen key; width clamped at both bounds; two shell keys stay independent |
| drag payload | same-`shellKey` drop routes to move; differing `shellKey` routes to transfer; malformed payload is ignored, not thrown on |
| `shellTransfer` | files-only selection takes the download/upload route; a selection containing a folder takes the zip/extract route; partial failure still invalidates both sides |
| `ShellSidebar` | Git rail entry absent without a `git` prop, present with one |
| `PanelHeader` / `PaneCanvas` | `leadingContent` renders only for the first leaf; a split shows exactly one toggle |
| Cmd/Ctrl+B | toggles only the `isFocused` shell; a split leaves the unfocused shell's sidebar alone |

**Backend**

| Unit | Test |
|---|---|
| `Extract` happy path | worktree and SSH: nested dirs and files land at the right paths |
| zip-slip | `../x`, `/abs/x`, `a/../../x` each rejected; destination left untouched |
| symlink entry | rejected |
| budgets | entry-count and uncompressed-size caps reject before any write |
| error shape | `{"error": "..."}` envelope on every failure path |

The in-pane `explorer` and `git` pane tabs must behave identically before and
after — that is the regression surface.

## Implementation order

`backend/cmd/server/main.go` and `frontend/src/store/useDevDeckStore.ts` are
convergence files (`ORCHESTRATION.md`); each is touched in exactly one serialized
step and nothing else may edit them in parallel.

1. Worktree `Extract` service + handler + Go tests.
2. SSH `Extract` service + handler + Go tests.
3. Route registration in `main.go` *(serialized)*.
4. `shellSidebars` store slice *(serialized)*.
5. `ShellSidebar` component.
6. `PanelHeader.leadingContent` + `PaneCanvas.paneLeadingContent` + `firstLeafId`.
7. Mount in `ExpandedTerminal` and `SSHShellPane`; Cmd/Ctrl+B branch in the
   existing keydown handlers.
8. Drag payload extension + `shellTransfer.ts` + wiring into `TerminalExplorer`'s
   drop handler.

Verify with `go vet ./...`, `go test ./...`, `npm run typecheck`, `npx vitest run`,
`npm run build`.
