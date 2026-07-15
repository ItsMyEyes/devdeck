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
