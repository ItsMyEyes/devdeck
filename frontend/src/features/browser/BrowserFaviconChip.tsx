import { cn } from '@/lib/utils'

const CHIP_COLORS = [
  'bg-devdeck-accent-tint text-devdeck-accent-soft',
  'bg-devdeck-green-tint text-devdeck-green-soft',
  'bg-devdeck-yellow/20 text-devdeck-yellow',
  'bg-devdeck-red-tint text-devdeck-red-soft',
]

function chipColorFor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return CHIP_COLORS[hash % CHIP_COLORS.length]
}

export interface BrowserFaviconChipProps {
  /** Stable id the chip's color is derived from (a bookmark id or an
   *  internal doc id) — deliberately not the title, so two pages sharing a
   *  title still get visually distinct chips. */
  seed: string
  title: string
  iconDataUrl?: string | null
  size?: number
  className?: string
}

/** First-letter chip fallback for a real favicon (deferred — see the
 *  chrome-replication design spec §2). Shared by the bookmarks-home grid
 *  and the tab strip's favicon slot so both pick up real favicons
 *  identically once that lands, without a layout change — the slot's
 *  dimensions are reserved today. */
export function BrowserFaviconChip({ seed, title, iconDataUrl, size = 20, className }: BrowserFaviconChipProps) {
  if (iconDataUrl) {
    return (
      <img
        src={iconDataUrl}
        alt=""
        style={{ height: size, width: size }}
        className={cn('flex-none rounded-[3px]', className)}
      />
    )
  }
  return (
    <div
      style={{ height: size, width: size }}
      className={cn(
        'flex flex-none items-center justify-center rounded-[3px] text-[10px] font-semibold',
        chipColorFor(seed),
        className,
      )}
    >
      {(title.trim()[0] ?? '?').toUpperCase()}
    </div>
  )
}
