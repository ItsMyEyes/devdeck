import { useCallback, useEffect, useState } from 'react'
import type { RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { cn } from '@/lib/utils'
import { collectHeadings, type OutlineHeading } from './outline'

/** Dash length by heading level — the rail reads as the document's shape. */
const DASH: Record<number, string> = { 1: 'w-4', 2: 'w-3', 3: 'w-2.5' }

/** How far below the top of the scroll port a heading has to have travelled
 *  before the rail calls it the current one. A heading still lower than this
 *  is not what's being read. */
const ACTIVE_OFFSET = 96

/** Left of a heading when scrolling to it, so it doesn't sit flush at the edge. */
const SCROLL_MARGIN = 24

function label(heading: OutlineHeading): string {
  return heading.text || 'Untitled'
}

/**
 * The outline rail on the right edge of a document: one dash per heading, the
 * current one lit, and the heading titles on hover. Click a dash or a title to
 * scroll there.
 *
 * Notion's table-of-contents rail. Written here rather than pulled in because
 * Tiptap's table-of-contents extension is a Pro package.
 *
 * `scrollRef` is the element that actually scrolls — the rail is positioned
 * against its box and tracks the current heading from its scroll offset, so it
 * has to be given the container, not find one.
 */
export function DocumentOutline({
  editor,
  scrollRef,
  className,
}: {
  editor: Editor | null
  scrollRef: RefObject<HTMLElement | null>
  className?: string
}) {
  const [headings, setHeadings] = useState<OutlineHeading[]>([])
  const [activePos, setActivePos] = useState<number | null>(null)

  useEffect(() => {
    if (!editor) {
      setHeadings([])
      return
    }
    const read = () => setHeadings(collectHeadings(editor.state.doc))
    read()
    editor.on('update', read)
    return () => {
      editor.off('update', read)
    }
  }, [editor])

  useEffect(() => {
    const container = scrollRef.current
    if (!editor || !container || headings.length === 0) return

    let frame = 0
    const measure = () => {
      frame = 0
      const line = container.getBoundingClientRect().top + ACTIVE_OFFSET
      let active = headings[0].pos
      for (const heading of headings) {
        const dom = editor.view.nodeDOM(heading.pos)
        if (dom instanceof HTMLElement && dom.getBoundingClientRect().top <= line) {
          active = heading.pos
        }
      }
      setActivePos(active)
    }
    // rAF-coalesced: scroll fires far more often than the rail can change.
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }

    measure()
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [editor, scrollRef, headings])

  const scrollTo = useCallback(
    (pos: number) => {
      const container = scrollRef.current
      const dom = editor?.view.nodeDOM(pos)
      if (!container || !(dom instanceof HTMLElement)) return
      const delta = dom.getBoundingClientRect().top - container.getBoundingClientRect().top
      container.scrollTo({ top: container.scrollTop + delta - SCROLL_MARGIN, behavior: 'smooth' })
    },
    [editor, scrollRef],
  )

  // One heading is not an outline — the rail would be a single dash claiming to
  // navigate a document with nowhere to go.
  if (headings.length < 2) return null

  return (
    <nav
      aria-label="Document outline"
      // pointer-events-none on the container, auto on the controls: the rail
      // floats over the page's right margin and must not swallow clicks meant
      // for the document underneath it.
      className={cn(
        'group pointer-events-none absolute top-1/2 right-0 z-20 hidden -translate-y-1/2 md:block',
        className,
      )}
    >
      {/* Capped rather than scrollable: a rail with its own scrollbar is not a
          rail. A document with more headings than fit shows the first screenful
          and the hover panel carries the rest.

          `pl-8` is a transparent approach zone — a 16px dash is a small target
          to have to hit before the titles will show. It sits in the page's
          right margin, clear of the text column. */}
      <div className="pointer-events-auto flex max-h-[70vh] flex-col items-end gap-2 overflow-hidden py-2 pr-3 pl-8">
        {headings.map((heading) => (
          <button
            key={heading.pos}
            type="button"
            onClick={() => scrollTo(heading.pos)}
            aria-label={label(heading)}
            className={cn(
              'h-0.5 flex-none cursor-pointer rounded-full transition-colors',
              DASH[heading.level] ?? 'w-2',
              heading.pos === activePos
                ? 'bg-notion-text-strong'
                : 'bg-notion-text-dim hover:bg-notion-text',
            )}
          />
        ))}
      </div>

      <div className="pointer-events-none absolute top-1/2 right-8 hidden max-h-[70vh] w-56 -translate-y-1/2 flex-col gap-px overflow-y-auto rounded-md bg-notion-surface p-1.5 font-[family-name:var(--nt-font)] opacity-0 shadow-[var(--nt-shadow)] transition-opacity group-hover:pointer-events-auto group-hover:flex group-hover:opacity-100">
        {headings.map((heading) => (
          <button
            key={heading.pos}
            type="button"
            onClick={() => scrollTo(heading.pos)}
            style={{ paddingLeft: 6 + (Math.min(heading.level, 4) - 1) * 12 }}
            className={cn(
              'cursor-pointer truncate rounded-sm py-1 pr-2 text-left text-[12.5px] transition-colors hover:bg-notion-hover',
              heading.pos === activePos ? 'text-notion-text-strong' : 'text-notion-text-dim',
            )}
          >
            {label(heading)}
          </button>
        ))}
      </div>
    </nav>
  )
}
