// Where an explorer drop lands, and which of its entries actually move.
//
// Split out of TerminalExplorer because the previous inline version was the
// bug (spec: docs/superpowers/specs/2026-08-05-explorer-dnd-clipboard-design.md,
// "Cause 2"): the container's drop handler resolved its destination from the
// *selection* (`uploadTarget`) rather than from the pointer. Clicking a file
// selects it, so click-then-drag onto empty tree space resolved to that
// file's own parent, every move was filtered out as `from === to`, and the
// handler returned without a toast. Indistinguishable from a dead drop.
//
// The pointer decides now, as it does in VS Code. Kept pure so the
// resolution and rejection rules have direct unit coverage instead of only
// being reachable through a full tree render.

export interface DropRow {
  path: string
  isDir: boolean
}

export interface PlannedMove {
  from: string
  to: string
}

export type DropPlan =
  | { ok: true; moves: PlannedMove[]; alreadyThere: number }
  | { ok: false; reason: string }

/** `a/b/c.txt` → `a/b`; a top-level path → `''` (the tree root). */
export function parentPath(filePath: string): string {
  const index = filePath.lastIndexOf('/')
  return index >= 0 ? filePath.slice(0, index) : ''
}

export function basename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

/**
 * The folder a drop over `row` targets: the folder itself when the pointer is
 * over a folder, the containing folder when it is over a file, and the tree
 * root when it is over empty space or the tree container.
 */
export function resolveDropFolder(row: DropRow | null): string {
  if (!row) return ''
  return row.isDir ? row.path : parentPath(row.path)
}

/** True when `folder` is `path` itself or lives beneath it — the two ways a
 *  folder can be dropped into its own subtree. Compared segment-wise so
 *  `src2` is not mistaken for a child of `src`. */
function isSelfOrDescendant(folder: string, path: string): boolean {
  return folder === path || folder.startsWith(`${path}/`)
}

/**
 * What a drop of `paths` into `targetFolder` should actually do.
 *
 * Rejects (with a reason the caller surfaces as a toast) rather than silently
 * doing nothing — a drop that goes nowhere without explanation is the exact
 * failure this module exists to prevent. The one remaining silent outcome is
 * a plan whose `moves` are empty because every entry already lives in
 * `targetFolder`: that is a genuine no-op, and `alreadyThere` lets the caller
 * tell it apart from "nothing happened".
 */
export function planDrop(paths: readonly string[], targetFolder: string): DropPlan {
  if (paths.length === 0) return { ok: true, moves: [], alreadyThere: 0 }

  for (const path of paths) {
    if (isSelfOrDescendant(targetFolder, path)) {
      return { ok: false, reason: `Cannot move ${basename(path)} into itself` }
    }
  }

  const moves: PlannedMove[] = []
  let alreadyThere = 0
  for (const from of paths) {
    const to = targetFolder ? `${targetFolder}/${basename(from)}` : basename(from)
    if (from === to) alreadyThere += 1
    else moves.push({ from, to })
  }
  return { ok: true, moves, alreadyThere }
}
