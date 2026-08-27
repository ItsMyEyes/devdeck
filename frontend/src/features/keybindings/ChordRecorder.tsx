import { useEffect, useState } from 'react'
import { chordFromEvent } from '@/features/keybindings/chord'
import type { Chord } from '@/features/keybindings/chord'
import { KeyCap } from '@/features/keybindings/ChordPills'

/**
 * Captures the next chord the user presses.
 *
 * Listens on `window` in the **capture** phase and swallows the event outright:
 * every rewired handler in the app also listens on `window`, so without this
 * the chord being recorded would fire the command it is being unbound from
 * while the settings dialog is still open.
 *
 * Escape cancels rather than recording, which means Escape itself cannot be
 * bound from this UI — the same trade VS Code and Zed make, and the reason the
 * hint line says so out loud.
 */
export function ChordRecorder({
  onCapture,
  onCancel,
}: {
  onCapture: (chord: Chord) => void
  onCancel: () => void
}) {
  // Held modifiers, so the box reacts the moment Cmd goes down rather than
  // sitting inert until the letter lands.
  const [held, setHeld] = useState<string[]>([])

  useEffect(() => {
    function modifierTokens(event: KeyboardEvent): string[] {
      const tokens: string[] = []
      if (event.metaKey || event.ctrlKey) tokens.push('mod')
      if (event.altKey) tokens.push('alt')
      if (event.shiftKey) tokens.push('shift')
      return tokens
    }

    function handleKeyDown(event: KeyboardEvent) {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        onCancel()
        return
      }
      setHeld(modifierTokens(event))
      const chord = chordFromEvent(event)
      if (chord) onCapture(chord)
    }

    function handleKeyUp(event: KeyboardEvent) {
      setHeld(modifierTokens(event))
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
    }
  }, [onCapture, onCancel])

  const preview = held.map((token) => (token === 'mod' ? '⌘/Ctrl' : token === 'alt' ? 'Alt' : 'Shift'))

  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-lg border border-devdeck-border-accent bg-devdeck-accent-tint px-2.5 py-1"
    >
      {preview.length > 0 ? (
        preview.map((token) => <KeyCap key={token}>{token}</KeyCap>)
      ) : (
        <span className="font-mono text-[11px] text-devdeck-accent">Press a shortcut…</span>
      )}
      <span className="font-sans text-[10.5px] text-devdeck-fg-2">Esc to cancel</span>
    </span>
  )
}
