# Explorer Selection, Upload/Download, Delete Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `TerminalExplorer.tsx`'s checkbox-based file selection with VS Code-style click/Ctrl/Shift selection, then build drag-and-drop + paste upload, a live transfer status panel, and a Delete/Backspace confirmation dialog on top of it.

**Architecture:** Selection logic is extracted into a pure, unit-tested module (`fileTreeSelection.ts`). Uploads move from one batched multipart request to one XHR-based request per file (for live file-count + byte progress), orchestrated by a new `useFileTransfers` hook that reports into a new global `transfers` slice of `useLoomStore`, rendered by a new floating `TransferStatusPanel`. Delete gets a proper dialog (mirroring `ConfirmDeleteDialog.tsx`'s visual style) wired to both existing delete buttons and new Delete/Backspace keyboard handling.

**Tech Stack:** React 19, TanStack Query (`@tanstack/react-query`), zustand + immer, `@base-ui/react` Dialog primitive, Tailwind v4, lucide-react, sonner.

## Global Constraints

- Frontend imports use the `@/*` alias; never relative paths into `src/`.
- `verbatimModuleSyntax` is on — use `import type` for all type-only imports.
- Never hand-edit `frontend/src/routeTree.gen.ts`.
- Domain types mirrored between `frontend/src/store/types.ts` and `backend/internal/domain/models.go` are untouched by this plan (no backend changes at all).
- Run `cd frontend && npm run typecheck` before every commit; there is no frontend test runner configured yet — pure-logic modules get a standalone plain-assertion script (matching `frontend/src/features/terminal/paneTree.test.ts`'s convention), run manually via `npx tsx`.
- Icons: `lucide-react` only. Toasts: `sonner`. Dates/CVA/`cn()`: existing conventions, unchanged.

---

### Task 1: Selection model — pure logic module + TerminalExplorer wiring

**Files:**
- Create: `frontend/src/features/terminal/fileTreeSelection.ts`
- Create: `frontend/src/features/terminal/fileTreeSelection.test.ts`
- Modify: `frontend/src/features/terminal/TerminalExplorer.tsx`

**Interfaces:**
- Produces: `SelectedEntry { name: string; path: string; isDir: boolean }`, `SelectionState { selected: Readonly<Record<string, SelectedEntry>>; anchor: string | null }`, `ClickModifier = 'none' | 'toggle' | 'range'`, `modifierFromEvent(event): ClickModifier`, `emptySelection(): SelectionState`, `applySelectionClick(state, clicked, modifier, orderedPaths, entryOf): SelectionState` — all consumed by Task 2 (delete dialog needs `Object.values(selection.selected)`) and Task 5 (upload needs `uploadTarget` derived from `selection.selected`).

- [ ] **Step 1: Write the pure selection module**

```ts
// frontend/src/features/terminal/fileTreeSelection.ts

export interface SelectedEntry {
  name: string
  path: string
  isDir: boolean
}

export type SelectionMap = Readonly<Record<string, SelectedEntry>>

export interface SelectionState {
  selected: SelectionMap
  anchor: string | null
}

export type ClickModifier = 'none' | 'toggle' | 'range'

/** VS Code semantics: Shift wins over Ctrl/Cmd if both are held. */
export function modifierFromEvent(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): ClickModifier {
  if (event.shiftKey) return 'range'
  if (event.metaKey || event.ctrlKey) return 'toggle'
  return 'none'
}

export function emptySelection(): SelectionState {
  return { selected: {}, anchor: null }
}

/**
 * Computes the next selection state for a row click.
 *
 * `orderedPaths` must be every currently-visible row's path, top-to-bottom
 * (the caller derives this from the DOM at click time, since the tree is
 * lazily fetched per expanded directory and no in-memory ordered list
 * exists). `entryOf` resolves any of those paths to its entry; both
 * parameters are only consulted for `'range'` clicks.
 */
export function applySelectionClick(
  state: SelectionState,
  clicked: SelectedEntry,
  modifier: ClickModifier,
  orderedPaths: readonly string[],
  entryOf: (path: string) => SelectedEntry | undefined,
): SelectionState {
  if (modifier === 'toggle') {
    const next = { ...state.selected }
    if (next[clicked.path]) delete next[clicked.path]
    else next[clicked.path] = clicked
    return { selected: next, anchor: clicked.path }
  }

  if (modifier === 'range' && state.anchor) {
    const anchorIndex = orderedPaths.indexOf(state.anchor)
    const clickedIndex = orderedPaths.indexOf(clicked.path)
    if (anchorIndex !== -1 && clickedIndex !== -1) {
      const [start, end] = anchorIndex <= clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex]
      const next: Record<string, SelectedEntry> = {}
      for (const path of orderedPaths.slice(start, end + 1)) {
        const entry = entryOf(path)
        if (entry) next[path] = entry
      }
      return { selected: next, anchor: state.anchor }
    }
  }

  // 'none', or 'range' with no prior anchor / a stale anchor no longer visible.
  return { selected: { [clicked.path]: clicked }, anchor: clicked.path }
}
```

- [ ] **Step 2: Write the standalone assertion script**

```ts
// frontend/src/features/terminal/fileTreeSelection.test.ts
/**
 * Plain assertion-based tests, matching paneTree.test.ts's convention (no
 * Vitest/Jest configured in this project yet). Run manually with:
 *
 *   npx tsx src/features/terminal/fileTreeSelection.test.ts
 */

import { applySelectionClick, emptySelection, modifierFromEvent, type SelectedEntry } from './fileTreeSelection'

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

const A: SelectedEntry = { name: 'a.ts', path: 'a.ts', isDir: false }
const B: SelectedEntry = { name: 'b.ts', path: 'b.ts', isDir: false }
const C: SelectedEntry = { name: 'c.ts', path: 'c.ts', isDir: false }
const D: SelectedEntry = { name: 'd.ts', path: 'd.ts', isDir: false }
const ORDER = ['a.ts', 'b.ts', 'c.ts', 'd.ts']
const ENTRIES: Record<string, SelectedEntry> = { 'a.ts': A, 'b.ts': B, 'c.ts': C, 'd.ts': D }
const entryOf = (path: string) => ENTRIES[path]

check('modifierFromEvent: shift wins over ctrl/cmd', () => {
  assertEqual(modifierFromEvent({ metaKey: true, ctrlKey: false, shiftKey: true }), 'range', 'shift+meta')
  assertEqual(modifierFromEvent({ metaKey: true, ctrlKey: false, shiftKey: false }), 'toggle', 'meta only')
  assertEqual(modifierFromEvent({ metaKey: false, ctrlKey: true, shiftKey: false }), 'toggle', 'ctrl only')
  assertEqual(modifierFromEvent({ metaKey: false, ctrlKey: false, shiftKey: false }), 'none', 'no modifier')
})

check('plain click replaces the selection with just the clicked row', () => {
  const state = applySelectionClick({ selected: { 'x.ts': A }, anchor: 'x.ts' }, B, 'none', ORDER, entryOf)
  assertEqual(state.selected, { 'b.ts': B }, 'selected')
  assertEqual(state.anchor, 'b.ts', 'anchor')
})

check('ctrl/cmd click toggles a row into the selection', () => {
  const state = applySelectionClick(emptySelection(), A, 'toggle', ORDER, entryOf)
  assertEqual(state.selected, { 'a.ts': A }, 'added')
  const state2 = applySelectionClick(state, B, 'toggle', ORDER, entryOf)
  assertEqual(state2.selected, { 'a.ts': A, 'b.ts': B }, 'both present')
})

check('ctrl/cmd click toggles a row out of the selection', () => {
  const state = applySelectionClick({ selected: { 'a.ts': A, 'b.ts': B }, anchor: 'a.ts' }, A, 'toggle', ORDER, entryOf)
  assertEqual(state.selected, { 'b.ts': B }, 'a removed, b remains')
})

check('shift click selects the range between anchor and target (forward)', () => {
  const afterA = applySelectionClick(emptySelection(), A, 'none', ORDER, entryOf)
  const ranged = applySelectionClick(afterA, C, 'range', ORDER, entryOf)
  assertEqual(ranged.selected, { 'a.ts': A, 'b.ts': B, 'c.ts': C }, 'a through c')
  assertEqual(ranged.anchor, 'a.ts', 'anchor unchanged by range click')
})

check('shift click selects the range between anchor and target (backward)', () => {
  const afterC = applySelectionClick(emptySelection(), C, 'none', ORDER, entryOf)
  const ranged = applySelectionClick(afterC, A, 'range', ORDER, entryOf)
  assertEqual(ranged.selected, { 'a.ts': A, 'b.ts': B, 'c.ts': C }, 'a through c regardless of direction')
})

check('shift click with no prior anchor falls back to selecting just the clicked row', () => {
  const ranged = applySelectionClick(emptySelection(), D, 'range', ORDER, entryOf)
  assertEqual(ranged.selected, { 'd.ts': D }, 'single row')
  assertEqual(ranged.anchor, 'd.ts', 'anchor set')
})

console.log(`\n${passed} passed`)
```

- [ ] **Step 3: Run the script and verify it passes**

Run: `cd frontend && npx tsx src/features/terminal/fileTreeSelection.test.ts`
Expected: 7 `ok -` lines, then `7 passed`, exit code 0.

- [ ] **Step 4: Wire the new selection model into `TerminalExplorer.tsx`**

Replace the `selected` state, checkbox rendering, and row click handling. Full diff of the affected regions:

Replace the import block (lines 1-19) to add the new module and drop the now-unused `WorktreeFileEntry`-only checkbox wiring (kept, just reordered):

```tsx
import { useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, MouseEvent, MutableRefObject } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { Archive, ChevronRight, FilePlus2, Loader2, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { downloadWorktreeZip, type WorktreeFileEntry } from '@/lib/machineApi'
import { cn } from '@/lib/utils'
import type { Machine } from '@/store/types'
import { qk } from '@/features/data/keys'
import {
  useDeleteWorktreePaths,
  useInvalidateWorktreeFiles,
  useUploadWorktreeFiles,
  useWorktreeFiles,
  useWriteWorktreeFile,
} from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import {
  applySelectionClick,
  emptySelection,
  modifierFromEvent,
  type ClickModifier,
  type SelectedEntry,
  type SelectionState,
} from './fileTreeSelection'
import { MaterialFileIcon } from './MaterialFileIcon'
```

(`SelectedEntry` moves from being defined locally at line 30 to being imported — delete the local `type SelectedEntry = Pick<WorktreeFileEntry, 'name' | 'path' | 'isDir'>` declaration.)

Replace the selection state and its derivations (lines 66, 75-77, 95-106). `selected`/`setSelected` (the old `Record<string, SelectedEntry>` state) is replaced by `selection`/`setSelection`; every other `useState`/`useRef`/hook call already in the component (`expanded`, `zipping`, `uploadInputRef`, `root`, `writeFile`, `uploadFiles`, `deletePaths`, `invalidateFiles`, `isFetching`) stays exactly as-is, just with these two new refs added alongside them:

```tsx
  const [selection, setSelection] = useState<SelectionState>(emptySelection())
  const entryCacheRef = useRef<Map<string, SelectedEntry>>(new Map())
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const selectedEntries = useMemo(() => Object.values(selection.selected), [selection.selected])
  const selectedPaths = useMemo(() => selectedEntries.map((entry) => entry.path), [selectedEntries])
  const selectedCount = selectedEntries.length
```

```tsx
  function clearSelection() {
    setSelection(emptySelection())
  }

  function orderedVisiblePaths(): string[] {
    const container = treeContainerRef.current
    if (!container) return []
    return Array.from(container.querySelectorAll<HTMLElement>('[data-row-path]')).map(
      (el) => el.dataset.rowPath ?? '',
    )
  }

  function selectEntry(entry: SelectedEntry, modifier: ClickModifier) {
    setSelection((current) =>
      applySelectionClick(current, entry, modifier, orderedVisiblePaths(), (path) => entryCacheRef.current.get(path)),
    )
  }
```

(`toggleSelected` is removed entirely — superseded by `selectEntry`.)

Update `TreeLevelProps`/`TreeLevel` (lines 286-298, 355-411): remove the checkbox `<input>` (366-373), add `data-row-path`, register into the entry cache, and route clicks through `selectEntry`:

```tsx
interface TreeLevelProps {
  worktreeId: string
  machine: Machine
  path: string
  depth: number
  expanded: ReadonlySet<string>
  selected: Readonly<Record<string, SelectedEntry>>
  entryCache: MutableRefObject<Map<string, SelectedEntry>>
  onToggleDir: (path: string) => void
  onSelectEntry: (entry: SelectedEntry, modifier: ClickModifier) => void
  onOpenFile: (path: string) => void
  onRemovePath: (entry: SelectedEntry) => void
  deletePending: boolean
}
```

```tsx
      {entries.map((entry) => {
        const isOpen = entry.isDir && rest.expanded.has(entry.path)
        const isSelected = Boolean(rest.selected[entry.path])
        const selectedEntry: SelectedEntry = { name: entry.name, path: entry.path, isDir: entry.isDir }
        rest.entryCache.current.set(entry.path, selectedEntry)
        return (
          <div key={entry.path}>
            <div
              data-row-path={entry.path}
              className={cn('group flex h-[29px] items-center pr-1.5 hover:bg-loom-hover-wash', isSelected && 'bg-loom-accent/10')}
              style={{ paddingLeft: indent }}
            >
              <button
                type="button"
                onClick={(event: MouseEvent) => {
                  const modifier = modifierFromEvent(event)
                  rest.onSelectEntry(selectedEntry, modifier)
                  if (modifier === 'none') {
                    if (entry.isDir) rest.onToggleDir(entry.path)
                    else rest.onOpenFile(entry.path)
                  }
                }}
                title={entry.isDir ? entry.name : `Edit ${entry.name}`}
                aria-expanded={entry.isDir ? isOpen : undefined}
                className="flex h-full min-w-0 flex-1 cursor-pointer select-none items-center gap-1.5 pl-1.5 text-left"
              >
                <ChevronRight
                  size={11}
                  className={cn(
                    'flex-none text-loom-dim-3 transition-transform duration-100',
                    isOpen && 'rotate-90',
                    !entry.isDir && 'invisible',
                  )}
                />
                <MaterialFileIcon name={entry.name} isDir={entry.isDir} size={16} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-loom-fg-2">{entry.name}</span>
              </button>
              <button
                type="button"
                onClick={() => rest.onRemovePath(selectedEntry)}
                disabled={rest.deletePending}
                title={`Delete ${entry.name}`}
                className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-loom-dim opacity-0 hover:bg-loom-red-tint-hover hover:text-loom-red-soft group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
              >
                <Trash2 size={11} />
              </button>
            </div>
            {isOpen && <TreeLevel worktreeId={worktreeId} machine={machine} path={entry.path} depth={depth + 1} {...rest} />}
          </div>
        )
      })}
```

Update the `<TreeLevel>` call site in `TerminalExplorer`'s render (around line 256-268) to pass `selected={selection.selected}`, `entryCache={entryCacheRef}`, `onSelectEntry={selectEntry}` (replacing `onToggleSelected={toggleSelected}`), and give the scrolling tree container `ref={treeContainerRef}` (it currently has no ref):

```tsx
      <div ref={treeContainerRef} className="min-h-0 flex-1 overflow-auto py-1">
        <TreeLevel
          worktreeId={worktreeId}
          machine={machine}
          path=""
          depth={0}
          expanded={expanded}
          selected={selection.selected}
          entryCache={entryCacheRef}
          onToggleDir={toggleDir}
          onSelectEntry={selectEntry}
          onOpenFile={onOpenFile}
          onRemovePath={removeEntry}
          deletePending={deletePaths.isPending}
        />
      </div>
```

`removeEntry`'s signature changes from `(entry: SelectedEntry)` reading a `WorktreeFileEntry`-shaped object to the now-imported `SelectedEntry` — no body change needed since it already only reads `.name`/`.path`.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors. (Task 2 will still reference `removeEntry`/`removeSelected`, which are modified there, not here — this step only needs the selection plumbing to compile.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/terminal/fileTreeSelection.ts frontend/src/features/terminal/fileTreeSelection.test.ts frontend/src/features/terminal/TerminalExplorer.tsx
git commit -m "feat(explorer): VS Code-style click/Ctrl/Shift file selection"
```

---

### Task 2: Delete confirmation dialog + Delete/Backspace keyboard wiring

**Files:**
- Create: `frontend/src/features/terminal/DeleteFilesDialog.tsx`
- Modify: `frontend/src/features/terminal/TerminalExplorer.tsx`

**Interfaces:**
- Consumes: `SelectedEntry` from Task 1's `fileTreeSelection.ts`; `selectedEntries`/`selectedPaths`/`clearSelection`/`entryCacheRef` from Task 1's `TerminalExplorer.tsx` changes.
- Produces: `DeleteFilesDialog` component (props: `open, names, pending, onCancel, onConfirm`) — no other task depends on this beyond mounting it.

- [ ] **Step 1: Write `DeleteFilesDialog.tsx`**

```tsx
// frontend/src/features/terminal/DeleteFilesDialog.tsx
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'

export interface DeleteFilesDialogProps {
  open: boolean
  names: readonly string[]
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}

function bodyFor(names: readonly string[]) {
  if (names.length <= 1) return `This deletes "${names[0] ?? ''}". This cannot be undone.`
  const shown = names.slice(0, 8).join(', ')
  const more = names.length > 8 ? `, +${names.length - 8} more` : ''
  return `This deletes ${names.length} items: ${shown}${more}. This cannot be undone.`
}

export function DeleteFilesDialog({ open, names, pending, onCancel, onConfirm }: DeleteFilesDialogProps) {
  const title = names.length === 1 ? names[0] : `${names.length} items`
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onCancel()} width={400} z={70} className="border-loom-red-tint">
      <div className="mb-2.5 flex items-center gap-2.5">
        <TriangleAlert size={15} className="text-loom-red-soft" />
        <DialogTitle>Delete {title}</DialogTitle>
      </div>
      <DialogDescription className="mb-5 font-sans text-[12.5px] leading-[1.55] text-loom-muted">
        {bodyFor(names)}
      </DialogDescription>
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button variant="destructive-solid" onClick={onConfirm} disabled={pending}>
          Delete
        </Button>
      </div>
    </Dialog>
  )
}
```

- [ ] **Step 2: Wire it into `TerminalExplorer.tsx`, replacing both `window.confirm` call sites**

Add state and import (near the other `useState` calls, and add `import { DeleteFilesDialog } from './DeleteFilesDialog'`):

```tsx
  const [pendingDelete, setPendingDelete] = useState<SelectedEntry[] | null>(null)
```

Replace `removeEntry` and `removeSelected` (current lines 123-152) — they now stage the dialog instead of confirming inline, and a new `performDelete` does the actual mutation:

```tsx
  function removeEntry(entry: SelectedEntry) {
    setPendingDelete([entry])
  }

  function removeSelected() {
    if (selectedPaths.length === 0) return
    setPendingDelete(selectedEntries)
  }

  function performDelete() {
    if (!pendingDelete || pendingDelete.length === 0) return
    const paths = pendingDelete.map((entry) => entry.path)
    const label = pendingDelete.length === 1 ? (pendingDelete[0]?.name ?? 'selection') : `${pendingDelete.length} items`
    deletePaths.mutate(paths, {
      onSuccess: () => {
        toast.success(`Deleted ${label}`)
        setSelection((current) => {
          const next = { ...current.selected }
          let changed = false
          for (const path of paths) {
            if (next[path]) {
              delete next[path]
              changed = true
            }
          }
          return changed ? { selected: next, anchor: current.anchor } : current
        })
        onFileDeleted(paths)
        setPendingDelete(null)
      },
      onError: (error) => {
        toast.error(errorMessage(error, `Could not delete ${label}`))
        setPendingDelete(null)
      },
    })
  }
```

Add the keydown handler and attach it to the root `<aside>` (current line 184), plus render the dialog at the end of the returned JSX (just before the closing `</aside>`):

```tsx
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    if (selectedPaths.length === 0) return
    event.preventDefault()
    setPendingDelete(selectedEntries)
  }
```

```tsx
    <aside className="flex min-h-0 flex-1 flex-col bg-loom-surface" onKeyDown={handleKeyDown}>
```

```tsx
      <DeleteFilesDialog
        open={pendingDelete !== null}
        names={pendingDelete?.map((entry) => entry.name) ?? []}
        pending={deletePaths.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={performDelete}
      />
    </aside>
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Run `cd frontend && npm run dev`, open a worktree's file explorer:
1. Click a file, press Delete — dialog appears with the file's name; Cancel closes it without deleting; Delete confirms and removes it.
2. Ctrl/Cmd-click two files, press Backspace — dialog shows "2 items"; confirming deletes both and clears the selection.
3. Click the per-row trash icon on a single file — same dialog appears (not a native browser confirm).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/terminal/DeleteFilesDialog.tsx frontend/src/features/terminal/TerminalExplorer.tsx
git commit -m "feat(explorer): styled delete confirmation dialog + Delete/Backspace key"
```

---

### Task 3: XHR progress plumbing (upload/download byte + file progress)

**Files:**
- Modify: `frontend/src/lib/machineClient.ts`
- Modify: `frontend/src/lib/machineApi.ts`

**Interfaces:**
- Produces: `machineXhr<T>(machine, opts: XhrRequestOpts): Promise<T>` in `machineClient.ts`; `uploadWorktreeFileWithProgress(machine, worktreeId, folderPath, file, onProgress): Promise<WorktreeFileEntry[]>` and `downloadWorktreeZipWithProgress(machine, worktreeId, paths, onProgress): Promise<Blob>` in `machineApi.ts` — both consumed by Task 5's `useFileTransfers` hook.
- Removes: the old batched `uploadWorktreeFiles` function (superseded — one-request-per-file replaces it per the design doc) and `downloadWorktreeZip` (superseded by the progress-reporting version). Task 5 removes their last remaining callers.

- [ ] **Step 1: Add the shared XHR helper to `machineClient.ts`**

Export `resolveMachineRest` (currently private, line 70) by adding `export`:

```ts
export async function resolveMachineRest(machine: Machine): Promise<RequestOpts> {
```

Append this after `machineFetch` (after line 119):

```ts
export interface TransferProgress {
  loaded: number
  total: number
}

interface XhrRequestOpts {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: XMLHttpRequestBodyInit | null
  headers?: Record<string, string>
  onUploadProgress?: (progress: TransferProgress) => void
  onDownloadProgress?: (progress: TransferProgress) => void
  responseType: 'json' | 'blob'
}

/**
 * Like machineFetch, but via XMLHttpRequest so upload/download progress
 * events are available — fetch() doesn't expose upload progress in a
 * reliably supported way, and download progress via fetch needs a
 * ReadableStream reader loop that's more code than this for the same result.
 */
export async function machineXhr<T>(machine: Machine, opts: XhrRequestOpts): Promise<T> {
  const resolved = await resolveMachineRest(machine)
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(opts.method, `${resolved.base ?? ''}${opts.path}`)
    xhr.responseType = opts.responseType
    for (const [key, value] of Object.entries({ ...resolved.headers, ...opts.headers })) {
      xhr.setRequestHeader(key, value)
    }
    if (opts.onUploadProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) opts.onUploadProgress?.({ loaded: event.loaded, total: event.total })
      }
    }
    if (opts.onDownloadProgress) {
      xhr.onprogress = (event) => {
        if (event.lengthComputable) opts.onDownloadProgress?.({ loaded: event.loaded, total: event.total })
      }
    }
    xhr.onerror = () => reject(new ApiError('Network request failed', 0))
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as T)
        return
      }
      if (opts.responseType === 'blob') {
        reject(new ApiError(`Request failed with status ${xhr.status}`, xhr.status))
        return
      }
      const data = xhr.response as { error?: string } | null
      const message = data && typeof data.error === 'string' ? data.error : `Request failed with status ${xhr.status}`
      reject(new ApiError(message, xhr.status))
    }
    xhr.send(opts.body ?? null)
  })
}
```

- [ ] **Step 2: Add the progress-reporting functions to `machineApi.ts`, remove the superseded ones**

Remove `uploadWorktreeFiles` (lines 106-118) and `downloadWorktreeZip` (lines 124-135). Replace with:

```ts
export function uploadWorktreeFileWithProgress(
  machine: Machine,
  worktreeId: string,
  folderPath: string,
  file: File,
  onProgress: (progress: TransferProgress) => void,
): Promise<WorktreeFileEntry[]> {
  const form = new FormData()
  form.append('file', file)
  return machineXhr<WorktreeFileEntry[]>(machine, {
    method: 'POST',
    path: `/worktrees/${worktreeId}/files/upload?path=${encodeURIComponent(folderPath)}`,
    body: form,
    onUploadProgress: onProgress,
    responseType: 'json',
  })
}

export function downloadWorktreeZipWithProgress(
  machine: Machine,
  worktreeId: string,
  paths: readonly string[],
  onProgress: (progress: TransferProgress) => void,
): Promise<Blob> {
  return machineXhr<Blob>(machine, {
    method: 'POST',
    path: `/worktrees/${worktreeId}/files/zip`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
    onDownloadProgress: onProgress,
    responseType: 'blob',
  })
}
```

Update the import line at the top of `machineApi.ts` to pull in the new helper and type:

```ts
import { machineFetch, machineRequest, machineXhr, type TransferProgress } from './machineClient'
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: errors in `TerminalExplorer.tsx` and `queries.ts` for the now-removed `uploadWorktreeFiles`/`downloadWorktreeZip` imports — expected at this point, Task 5 fixes them. Confirm the errors are ONLY in those two files (i.e. `machineClient.ts`/`machineApi.ts` themselves compile clean) before moving on.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/machineClient.ts frontend/src/lib/machineApi.ts
git commit -m "feat(explorer): XHR-based upload/download with progress events"
```

---

### Task 4: Global `transfers` store slice

**Files:**
- Modify: `frontend/src/store/useLoomStore.ts`

**Interfaces:**
- Produces: `Transfer { id: string; kind: 'upload' | 'download'; label: string; totalFiles: number; completedFiles: number; totalBytes: number; loadedBytes: number; status: 'active' | 'done' | 'error'; error?: string }`, store fields/actions `transfers: Transfer[]`, `startTransfer(transfer: Transfer): void`, `updateTransferProgress(id: string, patch: { loadedBytes?: number; totalBytes?: number; completedFiles?: number }): void`, `finishTransfer(id: string, status: 'done' | 'error', error?: string): void`, `dismissTransfer(id: string): void` — consumed by Task 5's `useFileTransfers` and Task 7's `TransferStatusPanel`.

- [ ] **Step 1: Add the `Transfer` type near the other UI types (after `export type EditKind = ...` at line 27)**

```ts
export interface Transfer {
  id: string
  kind: 'upload' | 'download'
  label: string
  totalFiles: number
  completedFiles: number
  totalBytes: number
  loadedBytes: number
  status: 'active' | 'done' | 'error'
  error?: string
}
```

- [ ] **Step 2: Add the field to `LoomState`, right after `dirtyFileCount: number` (line 165)**

```ts
  /** In-flight/recently-finished file transfers for the explorer's upload/
   *  download status panel. Not persisted — purely a live progress view. */
  transfers: Transfer[]
```

- [ ] **Step 3: Add the four actions to the `LoomState` interface, after `popNativeOverlayBlocker` (line 231)**

```ts
  startTransfer: (transfer: Transfer) => void
  updateTransferProgress: (
    id: string,
    patch: { loadedBytes?: number; totalBytes?: number; completedFiles?: number },
  ) => void
  finishTransfer: (id: string, status: 'done' | 'error', error?: string) => void
  dismissTransfer: (id: string) => void
```

- [ ] **Step 4: Add the initial value in the `create()` initializer, after `confirmDelete: null,` (line 330)**

```ts
      transfers: [],
```

- [ ] **Step 5: Add the action implementations, after the `popNativeOverlayBlocker` implementation (line 458)**

```ts
      startTransfer: (transfer) => set((s) => void s.transfers.push(transfer)),
      updateTransferProgress: (id, patch) =>
        set((s) => {
          const t = s.transfers.find((t) => t.id === id)
          if (!t) return
          if (patch.loadedBytes !== undefined) t.loadedBytes = patch.loadedBytes
          if (patch.totalBytes !== undefined) t.totalBytes = patch.totalBytes
          if (patch.completedFiles !== undefined) t.completedFiles = patch.completedFiles
        }),
      finishTransfer: (id, status, error) =>
        set((s) => {
          const t = s.transfers.find((t) => t.id === id)
          if (t) {
            t.status = status
            t.error = error
          }
        }),
      dismissTransfer: (id) => set((s) => void (s.transfers = s.transfers.filter((t) => t.id !== id))),
```

- [ ] **Step 6: Confirm `partialize` (line 598) is untouched** — `transfers` must NOT appear there; it's deliberately excluded from persistence (matches the existing comment "Persist only harmless UI preferences").

- [ ] **Step 7: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no new errors from this file (the pre-existing Task 3 errors in `TerminalExplorer.tsx`/`queries.ts` remain until Task 5).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/store/useLoomStore.ts
git commit -m "feat(explorer): add transfers slice to useLoomStore for transfer status panel"
```

---

### Task 5: `useFileTransfers` orchestration hook + wire into `TerminalExplorer`

**Files:**
- Create: `frontend/src/features/terminal/useFileTransfers.ts`
- Modify: `frontend/src/features/terminal/TerminalExplorer.tsx`
- Modify: `frontend/src/features/data/queries.ts`

**Interfaces:**
- Consumes: `uploadWorktreeFileWithProgress`/`downloadWorktreeZipWithProgress` (Task 3), `startTransfer`/`updateTransferProgress`/`finishTransfer` (Task 4).
- Produces: `useFileTransfers(machine, worktreeId): { uploadFiles(folderPath, files): Promise<WorktreeFileEntry[]>; downloadZip(paths, label): Promise<Blob>; uploading: boolean; zipping: boolean }` — consumed directly by `TerminalExplorer.tsx` in this same task, and by Task 6 (drag-and-drop/paste reuse the same `uploadFiles`).

- [ ] **Step 1: Write the hook**

```ts
// frontend/src/features/terminal/useFileTransfers.ts
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import {
  downloadWorktreeZipWithProgress,
  uploadWorktreeFileWithProgress,
  type WorktreeFileEntry,
} from '@/lib/machineApi'
import { qk } from '@/features/data/keys'
import type { Machine } from '@/store/types'
import { useLoomStore } from '@/store/useLoomStore'

const UPLOAD_CONCURRENCY = 3

export function useFileTransfers(machine: Machine, worktreeId: string) {
  const queryClient = useQueryClient()
  const startTransfer = useLoomStore((s) => s.startTransfer)
  const updateTransferProgress = useLoomStore((s) => s.updateTransferProgress)
  const finishTransfer = useLoomStore((s) => s.finishTransfer)
  const [uploading, setUploading] = useState(false)
  const [zipping, setZipping] = useState(false)

  const uploadFiles = useCallback(
    async (folderPath: string, files: readonly File[]): Promise<WorktreeFileEntry[]> => {
      const id = crypto.randomUUID()
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
      startTransfer({
        id,
        kind: 'upload',
        label: folderPath || 'root',
        totalFiles: files.length,
        completedFiles: 0,
        totalBytes,
        loadedBytes: 0,
        status: 'active',
      })
      setUploading(true)

      const fileLoaded = new Array(files.length).fill(0)
      const uploaded: WorktreeFileEntry[] = []
      let firstError: unknown = null
      let completedFiles = 0

      async function uploadOne(index: number) {
        const file = files[index]
        if (!file) return
        try {
          const entries = await uploadWorktreeFileWithProgress(machine, worktreeId, folderPath, file, (progress) => {
            fileLoaded[index] = progress.loaded
            updateTransferProgress(id, { loadedBytes: fileLoaded.reduce((sum, n) => sum + n, 0) })
          })
          uploaded.push(...entries)
        } catch (error) {
          firstError = firstError ?? error
        } finally {
          completedFiles += 1
          updateTransferProgress(id, { completedFiles })
        }
      }

      const queue = files.map((_, index) => index)
      async function worker() {
        let index: number | undefined
        while ((index = queue.shift()) !== undefined) {
          await uploadOne(index)
        }
      }
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker))

      setUploading(false)
      finishTransfer(id, firstError ? 'error' : 'done', firstError instanceof Error ? firstError.message : undefined)
      await queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) })
      if (firstError) throw firstError
      return uploaded
    },
    [machine, worktreeId, startTransfer, updateTransferProgress, finishTransfer, queryClient],
  )

  const downloadZip = useCallback(
    async (paths: readonly string[], label: string): Promise<Blob> => {
      const id = crypto.randomUUID()
      startTransfer({
        id,
        kind: 'download',
        label,
        totalFiles: 1,
        completedFiles: 0,
        totalBytes: 0,
        loadedBytes: 0,
        status: 'active',
      })
      setZipping(true)
      try {
        const blob = await downloadWorktreeZipWithProgress(machine, worktreeId, paths, (progress) => {
          updateTransferProgress(id, { loadedBytes: progress.loaded, totalBytes: progress.total })
        })
        finishTransfer(id, 'done')
        return blob
      } catch (error) {
        finishTransfer(id, 'error', error instanceof Error ? error.message : undefined)
        throw error
      } finally {
        setZipping(false)
      }
    },
    [machine, worktreeId, startTransfer, updateTransferProgress, finishTransfer],
  )

  return { uploadFiles, downloadZip, uploading, zipping }
}
```

- [ ] **Step 2: Remove the superseded `useUploadWorktreeFiles` hook from `queries.ts`**

Delete lines 1048-1055 (`useUploadWorktreeFiles`) entirely, and remove `uploadWorktreeFiles` from the `machineApi` import list (line 130).

- [ ] **Step 3: Wire the hook into `TerminalExplorer.tsx`**

Replace the import of `useUploadWorktreeFiles` (from `@/features/data/queries`) and `downloadWorktreeZip` (from `@/lib/machineApi`) with:

```tsx
import { useFileTransfers } from './useFileTransfers'
```

Replace the mutation/state setup (current lines 67-71, 169-181):

```tsx
  const { uploadFiles, downloadZip, uploading, zipping } = useFileTransfers(machine, worktreeId)
```

(drop the local `zipping` `useState` and the old `uploadFiles = useUploadWorktreeFiles(...)` line — `uploadFiles`/`zipping` now come from the hook.)

Replace `handleUploadChange` and `zipSelected`:

```tsx
  async function uploadToFolder(folderPath: string, files: readonly File[]) {
    if (files.length === 0) return
    const label = folderPath || 'root'
    try {
      const entries = await uploadFiles(folderPath, files)
      toast.success(`Uploaded ${entries.length} file${entries.length === 1 ? '' : 's'} to ${label}`)
    } catch (error) {
      toast.error(errorMessage(error, `Could not upload to ${label}`))
    }
  }

  function handleUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    void uploadToFolder(uploadTarget, files)
  }

  async function zipSelected() {
    if (selectedPaths.length === 0 || zipping) return
    const filename = archiveFileName(selectedEntries)
    try {
      const blob = await downloadZip(selectedPaths, filename)
      downloadBlob(blob, filename)
      toast.success(`Zipped ${selectedPaths.length} item${selectedPaths.length === 1 ? '' : 's'}`)
    } catch (error) {
      toast.error(errorMessage(error, 'Could not zip selection'))
    }
  }
```

Update the upload button (current lines 208-216), which read `uploadFiles.isPending` from the old mutation hook — replace both occurrences with `uploading` from `useFileTransfers`:

```tsx
        <button
          type="button"
          onClick={() => uploadInputRef.current?.click()}
          disabled={uploading}
          title={`Upload files to ${uploadTargetLabel}`}
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-loom-dim hover:text-loom-fg disabled:cursor-wait"
        >
          {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
        </button>
```

The zip button (current lines 217-225) already reads a variable named `zipping` — no text change needed there, since `useFileTransfers`'s returned field is also called `zipping`; it's simply sourced from the hook's destructured return now instead of local `useState`.

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors — this resolves the errors left dangling from Task 3.

- [ ] **Step 5: Manual verification**

`cd frontend && npm run dev`, open a worktree's explorer, click Upload, pick 2-3 files: they upload (existing picker-based flow, now going through the new per-file path) and the file tree refreshes. Click Zip on a selection and confirm the download still works.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/terminal/useFileTransfers.ts frontend/src/features/terminal/TerminalExplorer.tsx frontend/src/features/data/queries.ts
git commit -m "feat(explorer): route upload/zip through useFileTransfers with live progress"
```

---

### Task 6: Drag-and-drop (row-precise) + paste-to-upload

**Files:**
- Modify: `frontend/src/features/terminal/TerminalExplorer.tsx`

**Interfaces:**
- Consumes: `uploadToFolder` (Task 5) as the single upload entry point for both drop targets and paste.

`DragEvent`, `ClipboardEvent`, and `MutableRefObject` are already in `TerminalExplorer.tsx`'s type-only import line from Task 1 — no further import changes needed in this task.

- [ ] **Step 1: Whole-panel drag-over/drop (fallback target: current `uploadTarget`)**

Add state and handlers, and attach them to the tree container div (the one holding `ref={treeContainerRef}` from Task 1):

```tsx
  const [isDragOver, setIsDragOver] = useState(false)

  function handleTreeDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setIsDragOver(true)
  }

  function handleTreeDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setIsDragOver(false)
  }

  function handleTreeDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragOver(false)
    const files = Array.from(event.dataTransfer.files ?? [])
    void uploadToFolder(uploadTarget, files)
  }
```

```tsx
      <div
        ref={treeContainerRef}
        onDragOver={handleTreeDragOver}
        onDragLeave={handleTreeDragLeave}
        onDrop={handleTreeDrop}
        className={cn(
          'min-h-0 flex-1 overflow-auto py-1',
          isDragOver && 'outline outline-2 outline-dashed outline-loom-accent -outline-offset-2',
        )}
      >
```

- [ ] **Step 2: Row-precise folder drop, overriding the panel-wide target**

Add drop-target state in `TerminalExplorer` and thread it + a drop callback down to `TreeLevel`:

```tsx
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
```

Pass to `TreeLevel`: `dropTargetPath={dropTargetPath}`, `onSetDropTarget={setDropTargetPath}`, `onDropFilesToFolder={(path, files) => void uploadToFolder(path, files)}` — add these to `TreeLevelProps` too:

```tsx
  dropTargetPath: string | null
  onSetDropTarget: (path: string | null) => void
  onDropFilesToFolder: (path: string, files: File[]) => void
```

In `TreeLevel`'s row `<div data-row-path={entry.path} ...>` (from Task 1), add folder-only drag handlers and drop-target styling:

```tsx
            <div
              data-row-path={entry.path}
              onDragOver={(event) => {
                if (!entry.isDir || !event.dataTransfer.types.includes('Files')) return
                event.preventDefault()
                event.stopPropagation()
                rest.onSetDropTarget(entry.path)
              }}
              onDragLeave={(event) => {
                if (!entry.isDir) return
                event.stopPropagation()
                rest.onSetDropTarget(null)
              }}
              onDrop={(event) => {
                if (!entry.isDir) return
                event.preventDefault()
                event.stopPropagation()
                rest.onSetDropTarget(null)
                rest.onDropFilesToFolder(entry.path, Array.from(event.dataTransfer.files ?? []))
              }}
              className={cn(
                'group flex h-[29px] items-center pr-1.5 hover:bg-loom-hover-wash',
                isSelected && 'bg-loom-accent/10',
                rest.dropTargetPath === entry.path && 'outline outline-2 outline-dashed outline-loom-accent -outline-offset-2',
              )}
              style={{ paddingLeft: indent }}
            >
```

`stopPropagation` on all three folder-row handlers is required so a drop exactly on a folder row doesn't ALSO bubble up and fire the whole-panel handler from Step 1 (which would otherwise upload to `uploadTarget` a second time in addition to the folder-precise upload).

- [ ] **Step 3: Paste-to-upload**

Add a paste handler and attach it to the root `<aside>` alongside the existing `onKeyDown` from Task 2:

```tsx
  function handlePaste(event: ClipboardEvent<HTMLElement>) {
    const files = Array.from(event.clipboardData?.files ?? [])
    if (files.length === 0) return
    event.preventDefault()
    void uploadToFolder(uploadTarget, files)
  }
```

```tsx
    <aside className="flex min-h-0 flex-1 flex-col bg-loom-surface" onKeyDown={handleKeyDown} onPaste={handlePaste}>
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual verification**

`cd frontend && npm run dev`, open a worktree's explorer:
1. Drag a file from Finder/Explorer onto a folder row — the row gets a dashed highlight while hovering, and dropping uploads into that folder regardless of what's currently selected.
2. Drag a file onto empty tree space — it uploads to whatever folder is currently selected (or root if nothing/multiple selected).
3. Click a row to focus the explorer, copy a file in Finder/Explorer, press Cmd/Ctrl+V — it uploads to the current selection's target.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/terminal/TerminalExplorer.tsx
git commit -m "feat(explorer): row-precise drag-and-drop and paste-to-upload"
```

---

### Task 7: Floating transfer status panel

**Files:**
- Create: `frontend/src/features/overlays/TransferStatusPanel.tsx`
- Modify: `frontend/src/features/overlays/GlobalOverlays.tsx`

**Interfaces:**
- Consumes: `transfers`/`dismissTransfer` from Task 4's store slice.

- [ ] **Step 1: Write the panel**

```tsx
// frontend/src/features/overlays/TransferStatusPanel.tsx
import { useEffect } from 'react'
import { CheckCircle2, Loader2, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLoomStore } from '@/store/useLoomStore'

const AUTO_DISMISS_MS = 4000

export function TransferStatusPanel() {
  const transfers = useLoomStore((s) => s.transfers)
  const dismissTransfer = useLoomStore((s) => s.dismissTransfer)

  useEffect(() => {
    const timers = transfers
      .filter((t) => t.status === 'done')
      .map((t) => setTimeout(() => dismissTransfer(t.id), AUTO_DISMISS_MS))
    return () => timers.forEach(clearTimeout)
  }, [transfers, dismissTransfer])

  if (transfers.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-1.5">
      {transfers.map((t) => {
        const percent =
          t.totalBytes > 0 ? Math.min(100, Math.round((t.loadedBytes / t.totalBytes) * 100)) : t.status === 'done' ? 100 : 0
        return (
          <div
            key={t.id}
            className="rounded-lg border border-loom-border-menu bg-loom-card p-3 text-loom-fg shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
          >
            <div className="mb-1.5 flex items-center gap-2">
              {t.status === 'active' && <Loader2 size={13} className="flex-none animate-spin text-loom-accent" />}
              {t.status === 'done' && <CheckCircle2 size={13} className="flex-none text-loom-green-soft" />}
              {t.status === 'error' && <XCircle size={13} className="flex-none text-loom-red-soft" />}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-loom-fg-2">
                {t.kind === 'upload' ? 'Uploading to' : 'Downloading'} {t.label}
              </span>
              {t.status !== 'active' && (
                <button
                  type="button"
                  onClick={() => dismissTransfer(t.id)}
                  className="flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-loom-dim hover:bg-loom-hover-wash hover:text-loom-fg"
                >
                  <X size={11} />
                </button>
              )}
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-loom-border-strong">
              <div
                className={cn('h-full rounded-full transition-[width]', t.status === 'error' ? 'bg-loom-red-soft' : 'bg-loom-accent')}
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-loom-dim">
              <span>
                {t.completedFiles}/{t.totalFiles} file{t.totalFiles === 1 ? '' : 's'}
              </span>
              <span>{t.error ?? `${percent}%`}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Mount it in `GlobalOverlays.tsx`**

```tsx
import { SpawnDialog } from './SpawnDialog'
import { NewProjectDialog } from './NewProjectDialog'
import { NewWorkspaceDialog } from './NewWorkspaceDialog'
import { FolderBrowser } from './FolderBrowser'
import { EditDrawer } from './EditDrawer'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import { TransferStatusPanel } from './TransferStatusPanel'
import { MachineDialog } from '@/features/machines/MachineDialog'
import { SSHConnectionDialog } from '@/features/ssh/SSHConnectionDialog'

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
      <TransferStatusPanel />
      <MachineDialog />
      <SSHConnectionDialog />
    </>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Full build + manual end-to-end verification**

Run: `cd frontend && npm run build`
Expected: build succeeds (same pre-existing "chunks larger than 500 kB" warning is fine, no new errors).

`cd frontend && npm run dev`, open a worktree's explorer, and confirm the whole feature end-to-end:
1. Upload several files via the picker — the floating panel appears bottom-right showing the folder name, a progress bar, "`x/y files`", and a `%`, and auto-dismisses a few seconds after completion.
2. Drag-drop a file onto a folder row — same panel behavior, targeting that folder.
3. Paste a copied file — same panel behavior.
4. Zip-download a selection — the panel shows a download entry with `%` progress.
5. Click/Ctrl-click/Shift-click selection still works as verified in Tasks 1-2; Delete/Backspace still opens the confirmation dialog.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/overlays/TransferStatusPanel.tsx frontend/src/features/overlays/GlobalOverlays.tsx
git commit -m "feat(explorer): floating upload/download transfer status panel"
```
