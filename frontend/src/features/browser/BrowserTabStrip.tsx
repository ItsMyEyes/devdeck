import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { BrowserDocState } from '@/store/useDevDeckStore'
import { BrowserFaviconChip } from './BrowserFaviconChip'
import { tabPillTargetWidth } from './browserTabWidth'
import { displayUrl } from './displayUrl'

export interface BrowserTabStripProps {
  docs: BrowserDocState[]
  activeDocId: string
  onSelect: (docId: string) => void
  onClose: (docId: string) => void
}

interface PillRecord {
  id: string
  doc: BrowserDocState
  closing: boolean
}

/** Left-aligned, clips rather than scrolls (design spec §3.2) —
 *  `overflow-hidden` lets each pill's own `truncate` compress before the strip
 *  would ever need a scroll affordance. Left-aligned, not centered: a centered
 *  strip reads as decoration, a left-aligned one reads as tabs. Rendered only
 *  at 2+ docs; `BrowserTile` owns that guard. */
export function BrowserTabStrip({ docs, activeDocId, onSelect, onClose }: BrowserTabStripProps) {
  const [pills, setPills] = useState<PillRecord[]>(() => docs.map((doc) => ({ id: doc.id, doc, closing: false })))

  // Keeps a *closing* pill in `pills` after the store has already dropped
  // its doc — its own onTransitionEnd below (via TabPill's onShrinkComplete)
  // removes it once the shrink-to-0 CSS transition actually finishes
  // (design spec §4.3: "stays until width hits 0, then spliced out").
  useEffect(() => {
    setPills((current) => {
      const next = docs.map((doc) => ({ id: doc.id, doc, closing: false }))
      const stillClosing = current.filter((p) => p.closing && !docs.some((d) => d.id === p.id))
      for (const prev of current) {
        if (prev.closing) continue
        if (!docs.some((d) => d.id === prev.id)) stillClosing.push({ ...prev, closing: true })
      }
      return [...next, ...stillClosing]
    })
  }, [docs])

  return (
    <div className="flex h-8 min-w-0 flex-none items-center justify-start gap-1 overflow-hidden border-b border-devdeck-border bg-devdeck-pane px-2">
      {pills.map((pill) => (
        <TabPill
          key={pill.id}
          doc={pill.doc}
          active={pill.id === activeDocId}
          single={false}
          closing={pill.closing}
          onSelect={() => onSelect(pill.id)}
          onClose={() => onClose(pill.id)}
          onShrinkComplete={() => setPills((current) => current.filter((p) => p.id !== pill.id))}
        />
      ))}
    </div>
  )
}

function TabPill({
  doc,
  active,
  single,
  closing,
  onSelect,
  onClose,
  onShrinkComplete,
}: {
  doc: BrowserDocState
  active: boolean
  single: boolean
  closing: boolean
  onSelect: () => void
  onClose: () => void
  onShrinkComplete: () => void
}) {
  const [mounted, setMounted] = useState(false)

  // Mounts at width 0, then sets the real computed width on the next frame
  // — the CSS transition needs a starting value to animate *from* (design
  // spec §4.3's "grow-in" mechanics).
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const label = active ? displayUrl(doc.url ?? '') : doc.title
  const width =
    closing || !mounted ? 0 : tabPillTargetWidth({ labelLength: label.length, hasFavicon: true, isActive: active })

  return (
    <button
      type="button"
      onClick={onSelect}
      onTransitionEnd={(event) => {
        if (closing && event.propertyName === 'width') onShrinkComplete()
      }}
      style={{ width }}
      className={cn(
        'group flex h-7 flex-none items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full px-3',
        'transition-[width] duration-200 ease-out',
        active && !single ? 'bg-devdeck-glass-solid' : 'hover:bg-devdeck-hover-wash',
      )}
    >
      <BrowserFaviconChip seed={doc.id} title={doc.title} size={16} />
      <span className={cn('min-w-0 flex-1 truncate text-left text-[11px]', active ? 'text-devdeck-fg' : 'text-devdeck-fg-2')}>
        {label}
      </span>
      <span
        role="button"
        tabIndex={0}
        aria-label={`Close ${doc.title}`}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
        className={cn(
          'flex h-5 w-5 flex-none items-center justify-center rounded-full opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100',
          'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60',
        )}
      >
        <X size={11} />
      </span>
    </button>
  )
}
