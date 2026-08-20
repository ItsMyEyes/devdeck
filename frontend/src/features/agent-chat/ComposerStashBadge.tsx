/**
 * Plan T7 — bookmark pill perched on the composer's top-right shoulder.
 * Ported from t3code's `ComposerStashBadge.tsx:14-56`, restyled to this
 * repo's semantic `--devdeck-*` tokens (`bg-devdeck-raised`,
 * `text-devdeck-fg`/`text-devdeck-fg-2`, `border-devdeck-hairline`) instead
 * of t3code's shadcn tokens, same instruction `ComposerChip.tsx` followed.
 *
 * Presentational only: `count` and `onClick` are plain props, the parent
 * (`ChatComposer`, T9) owns the stash data. `onPointerDown` is prevented so
 * opening the stash menu never steals focus from the prompt editor — spec §6.
 */
import { Bookmark } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface ComposerStashBadgeProps {
  count: number
  onClick: () => void
  className?: string
}

export function ComposerStashBadge({ count, onClick, className }: ComposerStashBadgeProps) {
  if (count === 0) return null

  return (
    <button
      type="button"
      data-composer-stash-badge="true"
      aria-label={`Stashed prompts: ${count}. Open stash.`}
      onPointerDown={(event) => {
        // Keep the editor focused — opening the stash must not steal it.
        event.preventDefault()
      }}
      onClick={onClick}
      className={cn(
        'absolute -top-3 right-4 z-10 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-devdeck-hairline bg-devdeck-raised px-2.5 py-0.5 text-xs text-devdeck-fg-2 shadow-sm transition-colors hover:text-devdeck-fg',
        className,
      )}
    >
      <Bookmark className="size-3" aria-hidden="true" />
      Stash
      <span className="rounded-full bg-devdeck-hover-wash-menu px-1.5 text-[10px] font-medium tabular-nums text-devdeck-fg">
        {count}
      </span>
    </button>
  )
}
