# File Explorer: VS Code-style Selection, DnD/Paste Upload, Transfer Status Panel — Design

**Date:** 2026-07-15
**Status:** Approved (brainstorming complete)

## Goal

`TerminalExplorer.tsx`'s file tree currently uses a checkbox on every row for
selection (independent/additive toggle, no click-to-select). This is being
replaced with VS Code-style selection, which then becomes the basis for three
dependent features: drag-and-drop/paste upload targeting, a live
upload/download transfer status panel, and keyboard delete with a proper
confirmation dialog (replacing today's `window.confirm`).

All four pieces touch the same selection state in the same file, so they're
designed together here, with a phased build order below rather than four
separate specs.

## Decisions (from brainstorming)

1. **Selection semantics, full VS Code parity:** plain click selects one row
   (replacing prior selection); Ctrl/Cmd+click toggles a row into/out of the
   selection; Shift+click selects the contiguous range between the last
   clicked row (anchor) and the target, in current visible tree order.
   Checkboxes are removed — selection is shown via row highlight.
2. **Upload scope:** local machine → currently selected folder in the
   explorer (not explorer-to-explorer transfers).
3. **Drag-and-drop is row-precise:** dragging over a folder row highlights it
   as the drop target and uploads land there, overriding the current
   selection. Dropping on empty space or a file row uploads to the current
   selection's derived `uploadTarget` (unchanged logic: the single selected
   folder, or the parent of a single selected file, else root).
4. **Paste-to-upload:** Cmd/Ctrl+V while the explorer has focus reads
   `clipboardData.files` and uploads to the current `uploadTarget`.
5. **Upload requests: one HTTP request per file**, not one batched
   multipart request for the whole selection. This is a deliberate behavior
   change (accepted trade-off): uploads are no longer all-or-nothing — one
   file can fail while others succeed — in exchange for being able to show a
   live `x/y files` count instead of the count jumping straight to `y` when
   the whole batch finishes. No backend change is needed: the existing
   `POST /worktrees/{id}/files/upload` endpoint already accepts a single file
   per request.
6. **Status panel is a floating corner panel** (VS Code/Chrome-downloads
   style), visible regardless of which sidebar tab is open — not a bar
   scoped inside the explorer panel. This means transfer state must live in
   the global store, not local to `TerminalExplorer`.
7. **Download progress tracking is scoped to the existing "zip selected
   files" download** — no new per-file/per-folder download entry point is
   being added in this pass.
8. **Delete confirmation dialog replaces `window.confirm`** for both the
   toolbar bulk-delete and the existing per-row delete button, and is wired
   to the Delete and Backspace keys (covers Mac laptops, which have no
   forward-delete key) whenever the explorer has focus and a selection
   exists.

## Approaches considered

**Flatten the recursive tree into a single non-recursive list model** (one
array of `{path, depth, isDir}` computed from all expanded directories, and
render with one `.map()`) was considered for the shift-range/keyboard-nav
foundation. Rejected for this pass: it would also mean restructuring how each
directory's children are fetched (`useWorktreeFiles` is currently called
per-`TreeLevel`, matching react-query's lazy-per-directory model), which is a
bigger and riskier change than the actual ask requires.

**Order-registry on top of the existing recursive `TreeLevel` structure**
(chosen): each rendered row appends its path to an ordered ref array as it
mounts, in tree order. Shift-range selection is computed by slicing that
array between the anchor's index and the clicked row's index. This keeps the
existing per-directory lazy-fetch structure untouched and is a much smaller
change.

**Keep the single batched upload request, show only byte-level `%`**
(rejected per decision 5 above) — would have avoided the all-or-nothing
trade-off but couldn't produce a live file count, which was an explicit
requirement.

## Selection model

- Local state in `TerminalExplorer` changes shape from
  `Record<path, SelectedEntry>` (independent checkbox toggles) to also track
  an **anchor path** (the last plain-clicked or range-clicked row) used for
  Shift-range computation.
- Row click handler (in `TreeLevel`) branches on the click event's
  `metaKey`/`ctrlKey`/`shiftKey`:
  - No modifier → selection becomes `{ [path]: entry }`, anchor = path.
  - Ctrl/Cmd → toggle `path` in/out of the existing selection map; anchor
    updates to `path` regardless of add/remove.
  - Shift → selection becomes every path between the anchor's index and this
    row's index in the order-registry array (inclusive), anchor unchanged.
- The order-registry (`useRef<string[]>`, rebuilt each render pass as rows
  mount in order) gives the "current visible tree order" needed for Shift
  ranges, without changing the lazy per-directory fetch model.
- Checkboxes are removed from row markup; selected rows get a highlighted
  background instead (matching existing Loom v2 token conventions, no new
  color needed — reuse whatever hover/active token the codebase already
  defines for row highlighting).
- `uploadTarget`/`uploadTargetLabel` derivation (single selected folder, or
  parent of a single selected file, else root) is unchanged — it now reads
  from the new selection state.
- Multi-selection (Ctrl/Cmd or Shift) is for bulk delete / bulk zip-download
  only; upload always targets a single folder, so `uploadTarget` still falls
  back to root whenever the selection isn't exactly one folder (or one
  file's parent).

## Drag-and-drop + paste upload

- Each folder row gets `onDragOver`/`onDragEnter`/`onDragLeave`/`onDrop`
  handlers (independent of click-selection state). `onDragOver` calls
  `preventDefault()` and sets a "drop target" highlight distinct from the
  selection highlight; `onDrop` reads `dataTransfer.files` and uploads to
  that row's own path, regardless of what's currently selected.
- Dropping outside any folder row (empty tree area, or on a file row)
  uploads to the current `uploadTarget`.
- A `paste` listener on the explorer's container (`tabIndex`-focusable, so
  clicking a row moves focus there) reads `clipboardData.files` on Cmd/Ctrl+V
  and uploads to `uploadTarget` the same way the existing Upload button does.
- Both paths funnel into the same per-file upload call described below, so
  drag-drop, paste, and the existing file-picker button all report into the
  same transfer/progress plumbing.

## Per-file upload + progress plumbing

- `uploadWorktreeFiles` (`frontend/src/lib/machineApi.ts:106-118`) currently
  builds one `FormData` with every file and does a single `fetch`. This
  becomes N calls (one per file), still hitting
  `POST /worktrees/{id}/files/upload`, still going through `machineFetch`'s
  direct-vs-proxy resolution.
- Byte-level progress isn't available through `fetch` in a reliably
  supported way, so per-file upload switches to `XMLHttpRequest` with
  `xhr.upload.onprogress`, reporting `loaded`/`total` bytes for that file.
- The existing zip download (`downloadWorktreeZip`,
  `machineApi.ts:124-135`) switches from `fetch().blob()` to XHR with
  `responseType: 'blob'` and `xhr.onprogress`, using the `Content-Length`
  the backend already sets via `http.ServeContent` on the temp zip file
  (`backend/internal/handler/worktree_file.go:120-152`) — no backend change.
- A small number of files upload with limited concurrency (not fully
  sequential, not unbounded parallel) to keep the panel's progress
  reasonably smooth without hammering the backend; exact concurrency cap is
  an implementation detail, not a design commitment.

## Transfer status panel (global store)

Transfer state must be visible from a panel mounted at the app-shell level,
independent of which sidebar tab or workspace tile is active, so it goes into
`useLoomStore.ts` rather than staying local to `TerminalExplorer`:

```ts
interface Transfer {
  id: string
  kind: 'upload' | 'download'
  label: string            // folder name (upload) or "selection.zip" (download)
  totalFiles: number
  completedFiles: number
  totalBytes: number
  loadedBytes: number
  status: 'active' | 'done' | 'error'
  error?: string
}
```

Store additions: `transfers: Transfer[]`, plus `startTransfer`,
`updateTransferProgress(id, loadedBytes, totalBytes)`,
`completeTransferFile(id)`, `finishTransfer(id, status, error?)`,
`dismissTransfer(id)`.

New `TransferStatusPanel` component, mounted once at the app-shell/root
layout level, reads `transfers` from the store and renders a floating
bottom-corner panel (only when non-empty) listing each transfer with a
progress bar, `{completedFiles}/{totalFiles} files`, and computed `%` from
`loadedBytes/totalBytes`. Finished transfers auto-dismiss after a short delay
(exact timing is an implementation detail); errored transfers stay until
manually dismissed.

## Delete: keyboard + confirmation dialog

- A `keydown` handler on the explorer's container checks for `Delete` or
  `Backspace` with a non-empty selection, and opens a confirmation dialog
  (no direct deletion on keypress).
- The existing toolbar bulk-delete button and the per-row delete button both
  route through the same confirmation dialog instead of their current
  `window.confirm(...)` calls (`TerminalExplorer.tsx:124`, `:143`).
- The dialog is a **new component local to the `terminal` feature**, not a
  reuse of the global `confirmDelete`/`askDelete` store flow
  (`useLoomStore.ts:158`, scoped to `EditKind: 'worktree' | 'project' |
  'workspace' | 'machine' | 'ssh'`, a single id/name — doesn't fit a
  multi-path list well). It's visually styled to match
  `ConfirmDeleteDialog.tsx` (`TriangleAlert` icon, `DialogTitle`/
  `DialogDescription`, Cancel / `destructive-solid` Delete buttons, built on
  the shared `Dialog` primitive from `@/components/ui/dialog`), listing the
  selected paths (or a count, if many) in the body.
- On confirm, calls the existing `deletePaths.mutate(selectedPaths, ...)` /
  `DELETE /worktrees/{id}/files/delete` flow unchanged.

## Error handling

Upload/delete/download errors continue to surface via `sonner` toasts
(matching existing `TerminalExplorer.tsx` conventions), in addition to
marking the relevant `Transfer` as `status: 'error'` in the panel. No change
to the `{"error":"message"}` backend envelope or `handleStoreErr` usage —
this feature is frontend-only aside from calling existing endpoints more
times.

## Testing

- **Frontend:** unit tests for the selection reducer/handler (plain click,
  Ctrl/Cmd toggle, Shift range against a fixed order-registry array),
  covering edge cases (Shift with no prior anchor, Ctrl-click removing the
  last selected item). Component-level test for the delete confirmation
  dialog appearing on Delete/Backspace and not deleting until confirmed.
- **Backend:** no backend logic changes, so no new backend tests are
  required; existing `worktree_file` upload/delete/archive tests continue to
  cover the endpoints being called more frequently.

## Build order (for the implementation plan)

1. Selection model rewrite (order-registry, click/Ctrl/Shift handling,
   remove checkboxes) — foundation for everything else.
2. Delete confirmation dialog + Delete/Backspace wiring (smallest,
   independent of upload changes).
3. Per-file upload requests + XMLHttpRequest progress (upload button first,
   still using the file picker) + zip download progress.
4. Drag-and-drop (row-precise) and paste-to-upload, reusing the per-file
   upload plumbing from step 3.
5. Global `transfers` store slice + `TransferStatusPanel` component, wired
   to steps 3–4's progress events.
