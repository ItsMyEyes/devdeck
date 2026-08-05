# Explorer Drag-and-Drop, Clipboard, and Toolbar

## Problem

Dropping a file anywhere in `TerminalExplorer` — onto a folder in the same
tree, onto another shell's tree, or from Finder — does nothing. No move, no
upload, no error, no toast. The cross-shell transfer machinery
(`shellTransfer.ts`, the `files/extract` endpoints) was built and unit-tested
but has never visibly worked for the operator.

Investigation established three distinct causes. They are independent; fixing
any one alone leaves the feature broken.

### Cause 1 — Tauri intercepts drags before the web layer

`frontend/src-tauri/tauri.conf.json` does not set `dragDropEnabled` on the
`main` window. Tauri v2 defaults it to `true`, which routes drag-and-drop to
the native webview. Per the Tauri v2 config reference, it "is enabled by
default, but must be disabled on Windows to allow HTML5 drag and drop
functionality on the frontend." With it enabled, OS file drops never surface
as HTML5 `drop` events, and on Windows no in-page HTML5 drag works at all.

### Cause 2 — three silent no-op paths in `TerminalExplorer`

Each ends in an early `return` with no toast, so a failed drop is
indistinguishable from an ignored one:

1. `handleTreeDrop` resolves its destination to `uploadTarget`, which is the
   *currently selected* entry's own parent folder. Clicking a file selects it,
   so click-then-drag onto empty tree space computes `to === from`.
2. `moveEntries` filters out `from === to` moves and returns silently when
   nothing survives the filter — the exact outcome of (1).
3. `transferFromOtherShell` returns silently when the drag's origin shell is
   no longer in the registry.

### Cause 3 — no drag affordance

There is no drag image, folders do not expand while hovered, and the drop
highlight is a 2px dashed outline on a 29px row. A working drop and a broken
one look the same, which is why the failure was never localized.

Cause 1 is the one that matches the reported symptom exactly — *every* drop
dead, including OS file drops — because the two-panes-side-by-side layout the
report came from renders only under `useIsTauri`. The web build never shows
it. In the browser, where a single-pane explorer does render, the same report
is explained by Cause 2: click a file (which selects it), drag it onto empty
space, and the destination resolves to the folder it is already in.

Verified before any fix, under Playwright against real Chromium **and** real
WebKit: a same-pane drag onto a folder row moved the file on disk in both. So
the in-page handler wiring was never the problem.

## Goal

Explorer drag-and-drop that behaves like VS Code's, works across panes and
machines, and never fails silently.

## Non-goals

- Server-to-server transfer. Bytes continue to route through the browser
  (`download` → `upload`), as `shellTransfer.ts` already documents. A
  multi-gigabyte tree is the wrong shape for this and stays out of scope.
- Dragging files *out* of DevDeck into the OS.
- Multi-select drag across shells beyond what `ENTRY_DRAG_MIME` already
  carries.

## Architecture

### 1. Desktop: disable native drag interception

```json
{ "label": "main", "dragDropEnabled": false, ... }
```

Required on Windows for any HTML5 drag to work, and on macOS for OS file
drops to reach the tree's `drop` handler instead of the native layer.

### 2. Drop semantics

| Gesture | Result |
|---|---|
| drag within one shell | **move** |
| drag within one shell + ⌥/Alt | **copy** |
| drag between shells | **copy**, source kept |
| OS file drag onto the tree | upload |

Cross-shell is copy-only by decision: bytes cross the browser, and deleting a
source after an unverified remote write risks data loss across machines. The
`dropEffect` shown to the user reflects the resolved route, so the cursor
badge and the outcome never disagree.

### 3. Drop target resolution

A new pure module, `frontend/src/features/terminal/dropTarget.ts`, owns the
one decision that caused Cause 2:

```ts
resolveDropFolder(row: { path: string; isDir: boolean } | null): string
```

- folder row → that folder's path
- file row → that file's parent folder
- no row (empty space, container) → `''`, the tree root

The container handler no longer consults `uploadTarget`. Selection state stops
influencing where a drop lands — the pointer decides, as it does in VS Code.

Two rejections, each with a toast rather than a silent return:

- dropping a folder into itself or any of its own descendants
- dropping entries into the folder they already live in — silent only when
  *every* entry is already there, since that is a genuine no-op

Pure, so it is unit-testable without rendering the tree.

### 4. VS Code-style drag affordance

- **Drag image** — a pill rendered off-screen and passed to
  `setDragImage`, reading the entry name, or `N items` for a multi-selection.
- **Drop highlight** — the target folder row takes a filled accent wash and a
  1px accent ring; the tree root takes an inset ring when the target is `''`.
  Replaces the dashed outline.
- **Auto-expand** — hovering a collapsed folder for 600 ms during a drag
  expands it, so you can drill into a nested destination mid-drag. The timer
  is cancelled on leaving the row and on drop. Lives in
  `useDragAutoExpand(onExpand)` so the delay is testable with fake timers.
- Dragged rows keep their existing 40% dim.

### 5. Shared clipboard

`frontend/src/features/terminal/explorerClipboard.ts` — a module-level store
mirroring `shellTransfer.ts`'s registry pattern, for the same reason: two
shells are unrelated React mounts with no shared context.

```ts
interface ExplorerClipboard {
  shellKey: string
  paths: string[]
  hasDir: boolean
  mode: 'cut' | 'copy'
}
```

`setClipboard` / `getClipboard` / `subscribe`, consumed through
`useExplorerClipboard()` so every mounted tree's Paste enables the moment any
tree copies.

Paste routing:

| Clipboard origin | Mode | Result |
|---|---|---|
| same shell | copy | `copyFile` per entry |
| same shell | cut | `moveFile` per entry, clipboard cleared |
| other shell | either | `transferAcrossShells`, source kept |

A cut pasted into another shell copies and says so in its toast, rather than
deleting across a machine boundary.

### 6. Header: four inline actions

New File · New Folder · Refresh · Collapse All, matching the reference. New
Folder moves out of the `…` overflow; Collapse All is new and clears the
`expanded` set. The overflow keeps Upload, Zip, Editor dependencies, and
Delete.

### 7. Selection bar

`N selected` moves out of the header strip into its own row directly beneath
it, with a Clear action — the header has 200–560 px to spend and was already
crushing the root label.

## Error and empty states

Every drop path ends in exactly one of: a success toast naming the count, an
error toast carrying the server message via `errorMessage()`, or a documented
silent no-op (all entries already in the destination). No path returns
without user-visible feedback. A drag whose origin shell has unmounted reports
"That pane is no longer open" instead of returning silently.

## Testing

Vitest, added to `vite.config.ts`'s explicit `include` list:

- `dropTarget.test.ts` — folder/file/empty resolution; self-drop and
  descendant rejection; the all-entries-already-there no-op.
- `explorerClipboard.test.ts` — set/get/subscribe, cross-shell routing
  decision, cut-cleared-after-paste.
- `useDragAutoExpand.test.tsx` — expands after the delay, does not restart on
  repeated dragover, cancels on leave, never fires after unmount.
- `dragImage.test.ts` — label for one entry vs. a multi-selection; the element
  is attached when handed to `setDragImage`.

The tree's own wiring is covered end-to-end by Playwright rather than by a
jsdom render of `TerminalExplorer`: jsdom has no drag implementation, so a
component test there would assert on synthetic events that prove nothing about
the behaviour that was broken.

Playwright, against a real hub with two worktrees on two projects, in both
Chromium and WebKit:

- same-pane move — file relocates on disk
- ⌥-drag — copy lands and the source survives
- cross-pane drag — folder transfers into the other worktree, source kept
- the four header buttons and the selection bar render

The split (two panes side by side) only renders under `useIsTauri`, so the
Playwright run injects `__TAURI_INTERNALS__` to reach that layout from a
browser.

## Implementation order

1. `dragDropEnabled: false` (desktop unblock)
2. `dropTarget.ts` + wire the container/row handlers to it
3. Alt-copy and dropEffect
4. `explorerClipboard.ts` + Paste routing
5. Drag image, drop highlight, auto-expand
6. Header buttons + selection bar
7. Tests, typecheck, Playwright pass
