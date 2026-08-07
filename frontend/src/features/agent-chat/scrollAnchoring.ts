/**
 * Pure follow-mode logic for the chat timeline's auto-scroll. Kept out of
 * the component so the "am I still at the bottom" math is unit-testable
 * without mounting a scroll container.
 *
 * A strict "distance to bottom === 0" check re-arms the instant the user
 * nudges the scrollbar to read history, so the very next streamed chunk
 * yanks them back down. A small re-arm band above the true bottom absorbs
 * that jitter: the view still counts as "following" until the user has
 * scrolled meaningfully far away.
 */

/** Pixels of slack below which the timeline still counts as "at the
 *  bottom" and keeps auto-scrolling on new content. */
export const FOLLOW_REARM_THRESHOLD_PX = 40

export interface ScrollState {
  /** Total scrollable content height. */
  contentLength: number
  /** Current scroll offset from the top. */
  scroll: number
  /** Height of the visible scroll viewport. */
  scrollLength: number
}

/**
 * Whether the view should keep auto-scrolling to the bottom as new content
 * streams in. `endInset` accounts for a floating overlay (e.g. the
 * composer) that visually covers part of the scrollable area even though
 * it is not part of `scrollLength` — without it, content hidden behind the
 * composer would never count as "reached".
 */
export function shouldFollow(state: ScrollState, endInset: number): boolean {
  const distanceFromBottom = state.contentLength - state.scroll - state.scrollLength - endInset
  return distanceFromBottom <= FOLLOW_REARM_THRESHOLD_PX
}
