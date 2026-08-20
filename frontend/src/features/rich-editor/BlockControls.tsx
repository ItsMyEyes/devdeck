import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { GripVertical, Plus } from 'lucide-react'

/** One control button, and the unit the row is measured in. */
const SIZE = 24

/** How close to the edge of the scrolling pane the pointer has to get before
 *  the document starts following it, and the most it is pulled per frame. */
const SCROLL_ZONE = 64
const SCROLL_SPEED = 18

interface Target {
  /** Position *before* the hovered node, so `doc.nodeAt(pos)` is that node. */
  pos: number
  /** Offset from the top of the editor wrapper, already aligned to the block's
   *  first line rather than to its box. */
  top: number
}

/**
 * The x to resolve a block at, given where the pointer actually is.
 *
 * The gutter is rendered *outside* the editor (`left-0 -translate-x-full`), so
 * a pointer travelling from the text towards the handle spends its last inches
 * over coordinates that belong to no part of the document. `posAtCoords` answers
 * `null` there, which read as "no block under the pointer" and tore the controls
 * down a few pixels before they could be clicked.
 *
 * Clamping into the text column keeps the pointer's own `y` — the row it is on
 * is the row the gutter is for — so the controls stay put, and sliding up and
 * down the gutter still re-targets block by block.
 */
export function columnX(clientX: number, box: { left: number; right: number }): number {
  return Math.min(Math.max(clientX, box.left + 1), box.right - 1)
}

/**
 * How far the document should be pulled this frame, given where the pointer
 * sits in the scrolling pane's box.
 *
 * Zero unless the pointer is inside one of the edge bands; ramps to full speed
 * at the boundary and stays there beyond it, so creeping towards the edge
 * creeps and parking past it races.
 */
export function scrollStep(pointerY: number, box: { top: number; bottom: number }): number {
  const fromTop = pointerY - box.top
  if (fromTop < SCROLL_ZONE) return -SCROLL_SPEED * (1 - Math.max(fromTop, 0) / SCROLL_ZONE)
  const fromBottom = box.bottom - pointerY
  if (fromBottom < SCROLL_ZONE) return SCROLL_SPEED * (1 - Math.max(fromBottom, 0) / SCROLL_ZONE)
  return 0
}

/**
 * The scrolling pane the document sits in, if any.
 *
 * An HTML5 drag scrolls the *page* when the pointer reaches its edge, but
 * neither Chromium nor WebKit does the same for a nested `overflow: auto`
 * container — and DevDeck's document always sits in one (MarkdownFileEditor's
 * pane). Without `scrollStep` driving this by hand, the only blocks a drag
 * could reach were the ones already on screen, which in a file of any real
 * length made moving a block to another section impossible.
 */
function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      return el
    }
  }
  return null
}

/**
 * The block the pointer is over, as Notion scopes it: the innermost list item
 * if there is one, otherwise the top-level block. Pointing at a bullet three
 * levels deep should hand you that bullet, not the whole list.
 */
function targetAt(editor: Editor, wrapper: HTMLElement, event: MouseEvent): Target | null {
  const view = editor.view
  const found = view.posAtCoords({
    left: columnX(event.clientX, view.dom.getBoundingClientRect()),
    top: event.clientY,
  })
  if (!found) return null

  const $pos = view.state.doc.resolve(found.pos)
  let pos = found.pos
  if ($pos.depth > 0) {
    let depth = 1
    for (let d = $pos.depth; d >= 1; d--) {
      const name = $pos.node(d).type.name
      if (name === 'listItem' || name === 'taskItem') {
        depth = d
        break
      }
    }
    pos = $pos.before(depth)
  } else if (!view.state.doc.nodeAt(pos)) {
    // Depth 0 and no node here: a boundary with nothing to grab (an empty doc).
    return null
  }

  const dom = view.nodeDOM(pos)
  if (!(dom instanceof HTMLElement)) return null

  // Aligned to the first LINE, not to the block: a wrapped paragraph or an h1
  // would otherwise put the handle halfway down its own box.
  const rect = dom.getBoundingClientRect()
  const style = getComputedStyle(dom)
  const firstLine = Math.min(parseFloat(style.lineHeight) || rect.height, rect.height)
  const padTop = parseFloat(style.paddingTop) || 0
  const top = rect.top - wrapper.getBoundingClientRect().top + padTop + (firstLine - SIZE) / 2
  return { pos, top }
}

/**
 * Notion's block gutter: the `+` that adds a block below and the handle that
 * drags the block somewhere else, both following the block under the pointer.
 *
 * Built on ProseMirror directly (`@tiptap/pm`) rather than on Tiptap's
 * drag-handle extension, which is not in this project's dependency set.
 *
 * Lives in the page's left padding, outside the text column, so it needs
 * ~52px of gutter — hence `sm:flex`, and hence the widened page container in
 * MarkdownFileEditor. Surfaces without that room (the issue description
 * field, the comment composer) simply don't render it.
 */
export function BlockControls({
  editor,
  wrapperRef,
}: {
  editor: Editor
  /** The editor's positioning context — `top` is measured against it. */
  wrapperRef: RefObject<HTMLDivElement | null>
}) {
  const [target, setTarget] = useState<Target | null>(null)
  /** Held across the whole drag: the pointer leaves the gutter on the first
   *  move, and losing the target mid-drag would strand `view.dragging`. */
  const dragging = useRef(false)
  /** Tears down the auto-scroll loop started for the current drag. Null
   *  whenever no drag is in flight, or when the document does not scroll. */
  const endAutoScroll = useRef<(() => void) | null>(null)

  /**
   * Follows the pointer with the document for the length of one drag.
   *
   * `dragover` is the only pointer signal an HTML5 drag emits — `mousemove`
   * stops for its whole duration — and it is taken from the window rather than
   * the pane so it keeps arriving once the pointer has left the document (the
   * gutter, the pane's own padding, the strip above it). The scrolling itself
   * runs off `requestAnimationFrame`: browsers repeat `dragover` only every few
   * hundred milliseconds when the pointer is still, which is exactly when the
   * user is holding at the edge waiting for the document to move.
   */
  const startAutoScroll = useCallback(
    (initial: { x: number; y: number }) => {
      // A drag the browser abandoned without a `dragend` would otherwise leave
      // its loop running underneath this one.
      endAutoScroll.current?.()
      const scroller = scrollParent(editor.view.dom)
      if (!scroller) return
      let pointer = initial
      let frame = 0
      const track = (event: DragEvent) => {
        pointer = { x: event.clientX, y: event.clientY }
      }
      const step = () => {
        const box = scroller.getBoundingClientRect()
        // Horizontal check only: a pointer above or below the pane is still
        // asking for it to scroll, but one dragged off sideways (onto the file
        // tree, another pane) is not.
        if (pointer.x >= box.left && pointer.x <= box.right) {
          const delta = scrollStep(pointer.y, box)
          if (delta !== 0) scroller.scrollTop += delta
        }
        frame = window.requestAnimationFrame(step)
      }
      window.addEventListener('dragover', track)
      frame = window.requestAnimationFrame(step)
      endAutoScroll.current = () => {
        window.removeEventListener('dragover', track)
        window.cancelAnimationFrame(frame)
        endAutoScroll.current = null
      }
    },
    [editor],
  )

  // A drag interrupted by an unmount (the tab closes, the pane switches to raw
  // markdown) never fires `dragend`, so the loop has to be stopped here too.
  useEffect(() => () => endAutoScroll.current?.(), [])

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    // The hover zone is the padded page container, not the text column, so
    // moving into the gutter towards the handle doesn't dismiss it.
    const zone = wrapper.parentElement ?? wrapper

    const onMove = (event: MouseEvent) => {
      if (dragging.current) return
      const next = targetAt(editor, wrapper, event)
      // Guarded: mousemove fires continuously, and a fresh object every time
      // would re-render the row on every pixel.
      setTarget((prev) =>
        prev && next && prev.pos === next.pos && prev.top === next.top ? prev : next,
      )
    }
    const onLeave = () => {
      if (!dragging.current) setTarget(null)
    }

    zone.addEventListener('mousemove', onMove)
    zone.addEventListener('mouseleave', onLeave)
    return () => {
      zone.removeEventListener('mousemove', onMove)
      zone.removeEventListener('mouseleave', onLeave)
    }
  }, [editor, wrapperRef])

  /** Notion's `+`: an empty block below, then the "/" menu on it. */
  const insertBelow = useCallback(() => {
    if (!target) return
    const node = editor.state.doc.nodeAt(target.pos)
    if (!node) return
    const end = target.pos + node.nodeSize
    editor
      .chain()
      .insertContentAt(end, { type: 'paragraph' })
      .focus(end + 1)
      .insertContent('/')
      .run()
  }, [editor, target])

  const onDragStart = useCallback(
    (event: ReactDragEvent<HTMLButtonElement>) => {
      if (!target) return
      const view = editor.view
      const dom = view.nodeDOM(target.pos)
      if (!(dom instanceof HTMLElement)) return

      dragging.current = true
      // Selecting the node is what makes the drag carry the whole block:
      // ProseMirror's own drop handler moves `view.dragging.slice` for us,
      // including the drop cursor StarterKit already provides.
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, target.pos)))
      event.dataTransfer.clearData()
      event.dataTransfer.effectAllowed = 'move'
      // Firefox refuses to start a drag with an empty dataTransfer.
      event.dataTransfer.setData('text/plain', dom.textContent || ' ')
      event.dataTransfer.setDragImage(dom, 0, 0)
      view.dragging = { slice: view.state.selection.content(), move: true }
      startAutoScroll({ x: event.clientX, y: event.clientY })
    },
    [editor, target, startAutoScroll],
  )

  const onDragEnd = useCallback(() => {
    endAutoScroll.current?.()
    dragging.current = false
    editor.view.dragging = null
    setTarget(null)
  }, [editor])

  if (!target) return null

  return (
    <div
      className="absolute left-0 z-10 hidden -translate-x-full pr-1 select-none sm:flex"
      style={{ top: target.top }}
    >
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={insertBelow}
        aria-label="Add a block below"
        title="Click to add a block below"
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm text-notion-text-dim transition-colors hover:bg-notion-hover hover:text-notion-text"
      >
        <Plus size={16} />
      </button>
      <button
        type="button"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={() => editor.chain().setNodeSelection(target.pos).focus().run()}
        aria-label="Drag to move this block"
        title="Drag to move"
        className="flex h-6 w-6 cursor-grab items-center justify-center rounded-sm text-notion-text-dim transition-colors hover:bg-notion-hover hover:text-notion-text active:cursor-grabbing"
      >
        <GripVertical size={16} />
      </button>
    </div>
  )
}
