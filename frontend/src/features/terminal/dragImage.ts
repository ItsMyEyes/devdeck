// The label that follows the cursor during an explorer drag (spec §4).
//
// Without `setDragImage` the browser snapshots the dragged row — a full-width
// strip of the sidebar, cropped at the pane edge, that reads as a rendering
// glitch rather than as "you are carrying this file". VS Code draws a compact
// pill with the entry name instead; this builds the same thing.
//
// The element has to be in the document for the browser to rasterize it, and
// has to survive until after `dragstart` returns, so it is appended
// off-screen and removed on the next frame.

export function entryDragLabel(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? '1 item'
  return `${names.length} items`
}

export function setEntryDragImage(dataTransfer: DataTransfer, names: readonly string[]): void {
  if (typeof document === 'undefined' || typeof dataTransfer.setDragImage !== 'function') return

  const pill = document.createElement('div')
  pill.textContent = entryDragLabel(names)
  Object.assign(pill.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    padding: '4px 10px',
    borderRadius: '6px',
    background: 'rgba(24, 24, 27, 0.95)',
    border: '1px solid rgba(255, 255, 255, 0.14)',
    color: '#e4e4e7',
    font: '500 11.5px ui-monospace, SFMono-Regular, monospace',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>)

  document.body.appendChild(pill)
  dataTransfer.setDragImage(pill, 12, 12)
  requestAnimationFrame(() => pill.remove())
}
