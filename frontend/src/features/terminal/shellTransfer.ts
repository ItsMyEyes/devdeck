// Cross-shell drag-and-drop file transfer (spec §6): what happens when a
// dragged entry from one shell's TerminalExplorer is dropped onto another
// shell's tree — worktree-to-worktree, worktree-to-SSH, or SSH-to-SSH. A
// same-shell drop stays TerminalExplorer's existing move-within-tree path,
// completely unchanged; this file only runs when the drop's origin shellKey
// differs from the receiving tree's own.
//
// Kept free of React: TerminalExplorer instances live in independent
// component subtrees (two shells split side by side are two unrelated
// mounts of ExpandedTerminal/SSHShellPane), so there is no shared React
// context to thread a "source" tree's download functions through to a
// "destination" tree's drop handler. The registry below is the bridge —
// every mounted TerminalExplorer registers its own useFileTransfers
// primitives under its shellKey, and a drop looks up the dragged entries'
// origin by that same key. Both sidebars live in the same document (spec
// §6), so a plain in-memory Map is enough; no IPC, no server round trip.

import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import type { FilesTarget } from './filesTarget'

// ---- Drag payload ----
//
// Carried on TerminalExplorer's ENTRY_DRAG_MIME. `shellKey` identifies the
// drag's origin so a drop can tell a same-tree move apart from a transfer;
// `hasDir` is decided at drag-start time (the dragging shell already knows
// whether its selection contains a folder) and picks shellTransfer's route.

export interface ShellDragPayload {
  shellKey: string
  paths: string[]
  hasDir: boolean
}

export function encodeShellDragPayload(payload: ShellDragPayload): string {
  return JSON.stringify(payload)
}

/** Malformed or unparseable payloads are ignored, never thrown on — a drop
 *  could just as well be an unrelated external drag, or an old payload
 *  shape from a stale reload. */
export function parseShellDragPayload(raw: string): ShellDragPayload | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { shellKey, paths, hasDir } = parsed as Record<string, unknown>
  if (typeof shellKey !== 'string') return null
  if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string')) return null
  if (typeof hasDir !== 'boolean') return null
  return { shellKey, paths, hasDir }
}

// ---- Shell transfer handle registry ----
//
// What a shell's TerminalExplorer registers itself under (its own mount
// effect) so a *different* shell's drop handler can drive its download/
// upload/extract without either component knowing about the other's props.
// These are exactly useFileTransfers(target)'s own functions plus that
// target's file-query invalidator — nothing here is reimplemented, only
// referenced.
//
// Spec non-goals require "both surfaces coexist": ShellSidebar's own
// TerminalExplorer and the in-pane 'explorer' pane-tab TerminalExplorer can
// both be mounted at once under the identical shellKey. Keyed by shellKey
// alone, a plain single-slot Map can't tell those two registrations apart —
// whichever mounted (or unmounted) last would silently evict the other's
// still-live handle. Each shellKey therefore keeps a small registration
// stack instead of a single slot: the most recently registered handle is
// "current" (functionally interchangeable with any other live registration
// under the same shellKey — every mount targets the same shell), and
// unregistering only ever removes the exact handle instance being torn
// down, falling back to whatever else is still mounted underneath it.

export interface ShellTransferHandle {
  target: FilesTarget
  downloadFile: (path: string, label: string) => Promise<Blob>
  downloadZip: (paths: readonly string[], label: string) => Promise<Blob>
  uploadFiles: (folderPath: string, files: readonly File[]) => Promise<unknown>
  extractArchive: (folderPath: string, archive: Blob, label: string) => Promise<unknown>
  invalidate: () => unknown
}

const handles = new Map<string, ShellTransferHandle[]>()

export function registerShellTransferHandle(shellKey: string, handle: ShellTransferHandle): void {
  const existing = handles.get(shellKey)
  if (existing) existing.push(handle)
  else handles.set(shellKey, [handle])
}

/** Removes exactly `handle`'s own registration — a no-op if some other
 *  registration under `shellKey` already replaced it (nothing to undo) or if
 *  `handle` was never the current one to begin with. */
export function unregisterShellTransferHandle(shellKey: string, handle: ShellTransferHandle): void {
  const stack = handles.get(shellKey)
  if (!stack) return
  const next = stack.filter((registered) => registered !== handle)
  if (next.length === 0) handles.delete(shellKey)
  else handles.set(shellKey, next)
}

export function getShellTransferHandle(shellKey: string): ShellTransferHandle | undefined {
  const stack = handles.get(shellKey)
  return stack?.[stack.length - 1]
}

// ---- Drop routing ----

export type DropRoute = 'move' | 'transfer'

/**
 * Decides how a dragged-entry drop should be handled: a payload whose
 * `shellKey` matches the receiving tree's own is a same-tree move (spec §6's
 * pre-existing drag-to-move-into-folder path), anything else is a cross-shell
 * transfer. Factored out of TerminalExplorer's handleEntryDrop so this
 * routing decision — same-shellKey vs. differing-shellKey — has direct unit
 * coverage instead of only being reachable through a full component render.
 */
export function resolveDropRoute(payload: { shellKey: string }, ownShellKey: string): DropRoute {
  return payload.shellKey === ownShellKey ? 'move' : 'transfer'
}

// ---- Transfer routing ----

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

function archiveNameFromPaths(paths: readonly string[]): string {
  if (paths.length === 1) {
    const name = paths[0]?.split('/').pop()
    if (name) return `${name}.zip`
  }
  return 'selection.zip'
}

async function transferFiles(
  source: ShellTransferHandle,
  dest: ShellTransferHandle,
  paths: readonly string[],
  destFolder: string,
): Promise<void> {
  const results = await Promise.allSettled(
    paths.map(async (path) => {
      const name = path.split('/').pop() ?? path
      const blob = await source.downloadFile(path, name)
      await dest.uploadFiles(destFolder, [new File([blob], name)])
    }),
  )
  const failed = results.filter((result) => result.status === 'rejected').length
  if (failed > 0) toast.error(`Could not transfer ${failed} item${failed === 1 ? '' : 's'}`)
  if (failed < paths.length) {
    toast.success(`${paths.length - failed} item${paths.length - failed === 1 ? '' : 's'} transferred`)
  }
}

async function transferArchive(
  source: ShellTransferHandle,
  dest: ShellTransferHandle,
  paths: readonly string[],
  destFolder: string,
): Promise<void> {
  const name = archiveNameFromPaths(paths)
  try {
    const archive = await source.downloadZip(paths, name)
    await dest.extractArchive(destFolder, archive, name)
    toast.success(`Transferred ${paths.length} item${paths.length === 1 ? '' : 's'}`)
  } catch (error) {
    toast.error(errorMessage(error, 'Could not transfer selection'))
  }
}

/**
 * Routes a cross-shell drop per the spec §6 table: a files-only selection
 * goes per file through download → upload; a selection containing a folder
 * goes through a single zip-on-source → extract-on-destination round trip.
 * Progress for every leg rides `source`/`dest`'s own primitives (spec §6's
 * `useFileTransfers`, which already reports through the store's transfer
 * slice), so this function owns only the routing decision, the partial-
 * failure toast, and invalidating both sides' file queries once everything
 * has settled — success or failure.
 */
export async function transferAcrossShells(
  source: ShellTransferHandle,
  dest: ShellTransferHandle,
  paths: readonly string[],
  hasDir: boolean,
  destFolder: string,
): Promise<void> {
  try {
    if (hasDir) {
      await transferArchive(source, dest, paths, destFolder)
    } else {
      await transferFiles(source, dest, paths, destFolder)
    }
  } finally {
    await Promise.allSettled([source.invalidate(), dest.invalidate()])
  }
}
