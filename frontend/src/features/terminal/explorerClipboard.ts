// The Cut/Copy clipboard shared by every mounted explorer tree.
//
// Mirrors shellTransfer.ts's registry for the same structural reason: two
// shells split side by side are two unrelated mounts of ExpandedTerminal /
// SSHShellPane, with no shared React context to thread a clipboard through.
// It used to be `useState` inside TerminalExplorer, which made Copy in one
// pane and Paste in another silently do nothing — the second tree's
// clipboard was simply a different, empty piece of state.
//
// A plain module-level value plus a subscriber set is enough: both trees live
// in the same document, and the only cross-tree requirement is that every
// mounted tree's Paste enables the moment any tree copies.

export type ClipboardMode = 'cut' | 'copy'

export interface ExplorerClipboard {
  /** Which shell the entries were copied from — compared against the pasting
   *  tree's own key to route a same-shell move/copy apart from a cross-shell
   *  transfer, exactly as `resolveDropRoute` does for a drag. */
  shellKey: string
  paths: string[]
  /** Decided at copy time by the tree that owns the entries, and used to pick
   *  shellTransfer's per-file vs. zip route on a cross-shell paste. */
  hasDir: boolean
  mode: ClipboardMode
}

let clipboard: ExplorerClipboard | null = null
const subscribers = new Set<() => void>()

export function getExplorerClipboard(): ExplorerClipboard | null {
  return clipboard
}

export function setExplorerClipboard(next: ExplorerClipboard | null): void {
  clipboard = next
  for (const notify of subscribers) notify()
}

export function clearExplorerClipboard(): void {
  setExplorerClipboard(null)
}

/** `useSyncExternalStore`'s subscribe half — returns its own unsubscribe. */
export function subscribeExplorerClipboard(onChange: () => void): () => void {
  subscribers.add(onChange)
  return () => {
    subscribers.delete(onChange)
  }
}

export type PasteRoute = 'move' | 'copy' | 'transfer'

/**
 * How a paste into `ownShellKey` should be carried out.
 *
 * A cut pasted into a *different* shell resolves to `transfer`, not a move:
 * bytes cross the browser on the way, and deleting the source after an
 * unverified write on another machine is how a transfer turns into data loss.
 * The caller says so in its toast rather than quietly keeping the source.
 */
export function resolvePasteRoute(entry: ExplorerClipboard, ownShellKey: string): PasteRoute {
  if (entry.shellKey !== ownShellKey) return 'transfer'
  return entry.mode === 'cut' ? 'move' : 'copy'
}
