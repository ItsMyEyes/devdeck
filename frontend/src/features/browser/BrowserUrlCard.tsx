import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useNativeOverlayBlocker } from './useNativeOverlayBlocker'

export interface BrowserUrlCardProps {
  open: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: (value: string) => void
  onClose: () => void
}

/** Hide-while-open (design spec §3.0 technique 2): a minimal, single-purpose
 *  editor for the active doc's own URL — no suggestions list, no fuzzy
 *  ranking (that's the global command palette's job, not this card's — see
 *  the design spec §2). Opening it pushes an occlusion blocker scoped to
 *  this card's own rect via Slice 1's `useNativeOverlayBlocker`, not
 *  `'viewport'` — only *this* tile needs to hide, not every open Browser
 *  tile in the workspace. */
export function BrowserUrlCard({ open, draft, onDraftChange, onSubmit, onClose }: BrowserUrlCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useNativeOverlayBlocker(open, cardRef)

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.select())
  }, [open])

  if (!open) return null

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit(draft)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') onClose()
  }

  return (
    <>
      {/* Invisible, tile-scoped click-away backdrop — no visual scrim, since
          this card sits inside the tile's own bounds, not the viewport's. */}
      <div className="absolute inset-0 z-10" onClick={onClose} />
      <div
        ref={cardRef}
        onKeyDown={handleKeyDown}
        style={{ width: 'min(28rem, 100cqw - 4rem)' }}
        className="absolute left-1/2 top-[calc(2.25rem+0.75rem)] z-20 -translate-x-1/2 rounded-[13px] border border-devdeck-border-menu bg-devdeck-card p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.55)]"
      >
        <form onSubmit={handleSubmit} className="flex items-center gap-2 px-1">
          <Search size={13} className="flex-none text-devdeck-dim" />
          <Input
            ref={inputRef}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Search or enter URL"
            className="h-8 flex-1 border-none bg-transparent px-0 text-[12px] shadow-none focus-visible:ring-0 pointer-coarse:text-[16px]"
          />
        </form>
      </div>
    </>
  )
}
