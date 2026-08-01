export interface FrecencyEntry {
  hits: number
  lastUsedAt: number
}

export type FrecencyMap = Record<string, FrecencyEntry>

export const FRECENCY_CAP = 100

const STORAGE_PREFIX = 'devdeck.palette.frecency.'
const HALF_LIFE_MS = 7 * 86_400_000

function storageKey(wsId: string) {
  return `${STORAGE_PREFIX}${wsId}`
}

/**
 * Classic frecency: hit count decayed by age on a one-week half-life, so a
 * thing opened twice today outranks a thing opened ten times last month.
 * `now` is injected rather than read from `Date.now()` so the decay curve is
 * testable.
 */
export function frecencyScore(map: FrecencyMap, id: string, now: number): number {
  const entry = map[id]
  if (!entry) return 0
  const age = Math.max(0, now - entry.lastUsedAt)
  return entry.hits * Math.pow(2, -age / HALF_LIFE_MS)
}

/** Returns a new map. Past `FRECENCY_CAP`, the least recently used entry is
 *  evicted — bounded storage matters because ids include one-off browser
 *  tiles that will never be seen again. */
export function recordUse(map: FrecencyMap, id: string, now: number): FrecencyMap {
  const previous = map[id]
  const next: FrecencyMap = { ...map, [id]: { hits: (previous?.hits ?? 0) + 1, lastUsedAt: now } }

  const ids = Object.keys(next)
  if (ids.length <= FRECENCY_CAP) return next

  const oldest = ids.reduce((a, b) => (next[a].lastUsedAt <= next[b].lastUsedAt ? a : b))
  const { [oldest]: _dropped, ...kept } = next
  return kept
}

/** Drops entries whose id no longer resolves to a live entity. Returns the
 *  same reference when nothing changed, so callers can skip a write. */
export function pruneFrecency(map: FrecencyMap, liveIds: Set<string>): FrecencyMap {
  const ids = Object.keys(map)
  const survivors = ids.filter((id) => liveIds.has(id))
  if (survivors.length === ids.length) return map
  const next: FrecencyMap = {}
  for (const id of survivors) next[id] = map[id]
  return next
}

/** Never throws: private-mode and quota failures degrade to an empty map. */
export function loadFrecency(wsId: string): FrecencyMap {
  try {
    const raw = localStorage.getItem(storageKey(wsId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as FrecencyMap
  } catch {
    return {}
  }
}

/** Never throws — frecency is a convenience, not data worth failing over. */
export function saveFrecency(wsId: string, map: FrecencyMap): void {
  try {
    localStorage.setItem(storageKey(wsId), JSON.stringify(map))
  } catch {
    // Quota exceeded or storage disabled: the session keeps its in-memory map.
  }
}
