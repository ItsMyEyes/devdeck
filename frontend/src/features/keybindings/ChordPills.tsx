import { X } from 'lucide-react'
import { chordLabel, chordSpokenLabel, chordTokens } from '@/features/keybindings/chord'
import type { Chord } from '@/features/keybindings/chord'
import { cn } from '@/lib/utils'

/** One keycap. Shared by the settings table and the recording preview. */
export function KeyCap({ children, className }: { children: string; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-[5px] px-1.5',
        'border border-devdeck-border-strong bg-devdeck-card-wash',
        'font-mono text-[11px] leading-none text-devdeck-fg',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** A chord as a row of keycaps — `⌘ ⇧ F`. */
export function ChordPill({ chord, className }: { chord: Chord; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1', className)} title={chordLabel(chord)}>
      {chordTokens(chord).map((token, index) => (
        <KeyCap key={`${token}-${index}`}>{token}</KeyCap>
      ))}
    </span>
  )
}

/**
 * Every chord bound to one command, each removable.
 *
 * A command can hold more than one chord — "Delete selection" ships with both
 * Delete and Backspace — so this renders a list rather than a single value, and
 * the remove affordance is what makes the extra ones editable at all.
 */
export function ChordPillList({
  chords,
  onRemove,
}: {
  chords: Chord[]
  onRemove?: (chord: Chord) => void
}) {
  if (chords.length === 0) {
    return <span className="font-mono text-[11px] italic text-devdeck-fg-2">Unbound</span>
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1.5 justify-end">
      {chords.map((chord) => (
        <span key={chord} className="group/chord inline-flex items-center gap-1">
          <ChordPill chord={chord} />
          {onRemove ? (
            <button
              type="button"
              aria-label={`Remove ${chordSpokenLabel(chord)}`}
              onClick={() => onRemove(chord)}
              className={cn(
                'flex h-[18px] w-[18px] flex-none items-center justify-center rounded text-devdeck-fg-2',
                'opacity-0 transition-opacity hover:bg-devdeck-red-tint-hover hover:text-devdeck-err',
                'group-hover/chord:opacity-100 focus-visible:opacity-100',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              )}
            >
              <X size={11} />
            </button>
          ) : null}
        </span>
      ))}
    </span>
  )
}
