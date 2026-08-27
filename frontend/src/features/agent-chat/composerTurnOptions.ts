/**
 * Per-thread memory for the composer's Reasoning / Context Window picks.
 *
 * Effort and context window ride the NEXT turn (`turnModel` in
 * `AgentChatPane.tsx`), so unlike the two modes they are not thread state the
 * backend replays — nothing on the wire remembers them. Held as component
 * state alone they were right until the first remount: every tab, pane or
 * SSH-session switch put the pill back on "High · 200k" while the thread's
 * live session was still running under whatever was last picked, and the next
 * turn then silently restarted it on the defaults. This map, keyed like
 * `composerDrafts`, is what a remount (and a reload — it is persisted) reads
 * back.
 *
 * Only NON-default picks are stored, and a pick back to the default deletes
 * the key: "default" means "let the CLI decide", which is what the picker's
 * own "Default" badge promises, and it keeps the persisted blob from filling
 * with entries that say nothing.
 */
/** The picker's defaults, in a pure module so `useDevDeckStore` can read them
 *  without importing `ComposerControls.tsx` (a React module that itself
 *  reaches the store through `ModelPicker` — a cycle). `ComposerControls`
 *  re-exports both under their old names. */
export const DEFAULT_EFFORT = 'high'
export const DEFAULT_CONTEXT_WINDOW = '200k'

export interface ComposerTurnOptions {
  /** A `REASONING_OPTIONS` value, absent for the default. */
  effort?: string
  /** A `CONTEXT_WINDOW_PRESETS` value or a custom `<n>k`, absent for the default. */
  contextWindow?: string
  updatedAt: number
}

/** Bounded-map discipline shared with `composerDrafts.ts` (`MAX_COMPOSER_DRAFTS`):
 *  both live in one persisted blob, so neither may grow without limit. */
export const MAX_COMPOSER_TURN_OPTIONS = 50

/**
 * Returns a new map with `threadKey`'s entry updated from `patch`. A field
 * set to its default is dropped rather than stored; an entry left with no
 * non-default field is deleted. Past `MAX_COMPOSER_TURN_OPTIONS` the
 * least-recently-updated entry is evicted. `now` is injected, same as
 * `setDraft`, so eviction order is testable without a clock.
 */
export function setTurnOptions(
  map: Record<string, ComposerTurnOptions>,
  threadKey: string,
  patch: { effort?: string; contextWindow?: string },
  now: number,
): Record<string, ComposerTurnOptions> {
  const current = map[threadKey]
  const effort = patch.effort !== undefined ? patch.effort : current?.effort
  const contextWindow = patch.contextWindow !== undefined ? patch.contextWindow : current?.contextWindow

  const entry: ComposerTurnOptions = { updatedAt: now }
  if (effort !== undefined && effort !== DEFAULT_EFFORT) entry.effort = effort
  if (contextWindow !== undefined && contextWindow !== DEFAULT_CONTEXT_WINDOW) entry.contextWindow = contextWindow

  if (entry.effort === undefined && entry.contextWindow === undefined) {
    return clearTurnOptions(map, threadKey)
  }

  const next: Record<string, ComposerTurnOptions> = { ...map, [threadKey]: entry }
  const keys = Object.keys(next)
  if (keys.length <= MAX_COMPOSER_TURN_OPTIONS) return next

  const oldest = keys.reduce((a, b) => (next[a].updatedAt <= next[b].updatedAt ? a : b))
  const { [oldest]: _dropped, ...kept } = next
  return kept
}

/** Returns a new map with `threadKey` removed — the same reference when it
 *  was not present. */
export function clearTurnOptions(
  map: Record<string, ComposerTurnOptions>,
  threadKey: string,
): Record<string, ComposerTurnOptions> {
  if (!(threadKey in map)) return map
  const { [threadKey]: _dropped, ...kept } = map
  return kept
}
