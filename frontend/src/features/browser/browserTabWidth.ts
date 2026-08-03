export interface TabWidthInput {
  /** Display label's character count (post-clamp inputs beyond 28 chars
   *  don't change the result any further). */
  labelLength: number
  hasFavicon: boolean
  isActive: boolean
}

const CHAR_W = 6 // estimated px/char at text-[11px] — a calibrated estimate
                  // against DevDeck's proportional UI font, not an exact
                  // per-glyph size (see the chrome-replication design spec
                  // §4.2 and its §8 risk note on expected width jitter).
const CLOSE_W = 20
const CLOSE_GAP = 6
const FAVICON_W = 16
const FAVICON_GAP = 6
const BASE_PAD = 24 // px-3 both sides
const MIN_WIDTH = 72
const MAX_WIDTH = 220

/** Target width for one tab-strip pill, animated via CSS `transition-[width]`
 *  rather than a JS interpolation loop (design spec §4.1) — this function
 *  only computes the *target*, the compositor owns the animation. Ported
 *  from terminal-browser's `target()` with DevDeck's own metrics
 *  substituted; `MIN_WIDTH`/`MAX_WIDTH` clamping is a DevDeck-specific
 *  addition the reference didn't need. */
export function tabPillTargetWidth(input: TabWidthInput): number {
  let width = BASE_PAD + Math.min(input.labelLength, 28) * CHAR_W
  if (input.hasFavicon) width += FAVICON_W + FAVICON_GAP
  if (input.isActive) width += CLOSE_W + 6 // extra reserved space, active only
  width += CLOSE_W + CLOSE_GAP // unconditional close-slot reservation
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))
}
