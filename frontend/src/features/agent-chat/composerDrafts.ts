export interface ComposerDraft {
  text: string
  updatedAt: number
}

/** Bounded-map discipline matches `paletteFrecency.ts:8`: this map shares one
 *  persisted blob with every worktree layout, so unbounded growth matters. */
export const MAX_COMPOSER_DRAFTS = 50

/**
 * Returns a new map with `threadKey`'s draft set to `text`. Empty (or
 * whitespace-only) text deletes the key instead of storing `''` — an emptied
 * composer should not leave a phantom draft behind. Past
 * `MAX_COMPOSER_DRAFTS`, the least-recently-updated entry is evicted. `now`
 * is injected rather than read from `Date.now()`, same shape as
 * `paletteFrecency.ts:33-43`'s `recordUse`, so eviction order is testable
 * without a clock.
 */
export function setDraft(
  map: Record<string, ComposerDraft>,
  threadKey: string,
  text: string,
  now: number,
): Record<string, ComposerDraft> {
  if (text.trim() === '') {
    return clearDraft(map, threadKey)
  }

  const next: Record<string, ComposerDraft> = { ...map, [threadKey]: { text, updatedAt: now } }

  const keys = Object.keys(next)
  if (keys.length <= MAX_COMPOSER_DRAFTS) return next

  const oldest = keys.reduce((a, b) => (next[a].updatedAt <= next[b].updatedAt ? a : b))
  const { [oldest]: _dropped, ...kept } = next
  return kept
}

/** Returns a new map with `threadKey`'s draft removed. A no-op (returns the
 *  same reference) when the key is not present. */
export function clearDraft(
  map: Record<string, ComposerDraft>,
  threadKey: string,
): Record<string, ComposerDraft> {
  if (!(threadKey in map)) return map
  const { [threadKey]: _dropped, ...kept } = map
  return kept
}
