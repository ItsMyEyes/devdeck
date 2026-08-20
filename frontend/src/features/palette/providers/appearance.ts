import type { ThemePreference } from '@/features/theme/theme'
import type { PaletteItem } from '@/features/palette/paletteTypes'

/**
 * Used to be "Appearance: Light / Dark / System" in the command palette.
 * Light mode is disabled — DevDeck is dark-only — so there is no longer
 * anything to switch; this returns no rows. Kept as a function (rather than
 * removed from `useCommandPalette`) so re-enabling light mode later is a
 * change to this file only.
 */
export function appearanceItems(_current: ThemePreference): PaletteItem[] {
  return []
}
