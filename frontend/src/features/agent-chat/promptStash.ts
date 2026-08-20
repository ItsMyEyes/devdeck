export interface PromptStashEntry {
  id: string
  createdAt: string
  text: string
}

/** Cap on the flat, global stash queue — t3code's own bound
 *  (`promptStashStore.ts:17`), kept identical here. */
export const MAX_STASH_ENTRIES = 20

/** Own localStorage key, deliberately outside the store's `partialize` blob —
 *  see `promptStash.ts`'s `saveStash` doc comment for why. */
export const STASH_STORAGE_KEY = 'devdeck.composer.stash.v1'

const SNIPPET_MAX_CHARS = 90

function generateStashId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** Never throws: private-mode, blocked storage, or a corrupt payload all
 *  degrade to an empty stash rather than killing app boot from an import —
 *  same posture as `paletteFrecency.ts`'s `loadFrecency`. */
export function loadStash(): PromptStashEntry[] {
  try {
    const raw = localStorage.getItem(STASH_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as PromptStashEntry[]
  } catch {
    return []
  }
}

/**
 * Persists the queue immediately (stashing is a deliberate keystroke, not a
 * per-character autosave — nothing to debounce). Returns `false` on a quota
 * rejection or blocked storage so the caller can decline to commit the
 * in-memory change: `zustand`'s persist middleware calls `set()` before
 * `setItem()` with no rollback seam, so the store action (not this module)
 * has to gate on this boolean before applying anything.
 */
export function saveStash(entries: PromptStashEntry[]): boolean {
  try {
    localStorage.setItem(STASH_STORAGE_KEY, JSON.stringify(entries))
    return true
  } catch {
    return false
  }
}

/** Prepends the new entry as the newest. Returns a new array — past
 *  `MAX_STASH_ENTRIES`, the oldest (last) entry is evicted and returned
 *  alongside the list so a caller can toast about it. */
export function addStashEntry(
  entries: PromptStashEntry[],
  text: string,
  now: () => string,
): { entries: PromptStashEntry[]; evicted: PromptStashEntry | null } {
  const entry: PromptStashEntry = { id: generateStashId(), createdAt: now(), text }
  const next = [entry, ...entries]
  if (next.length <= MAX_STASH_ENTRIES) return { entries: next, evicted: null }
  const evicted = next.pop() ?? null
  return { entries: next, evicted }
}

/** Removes and returns the entry by id (restore = remove + return). Returns
 *  `null` for an unknown id and the *same* array reference back — mutates
 *  nothing, so a caller can skip a write when nothing was found. */
export function takeStashEntryFrom(
  entries: PromptStashEntry[],
  id: string,
): { entries: PromptStashEntry[]; entry: PromptStashEntry | null } {
  const entry = entries.find((candidate) => candidate.id === id) ?? null
  if (!entry) return { entries, entry: null }
  return { entries: entries.filter((candidate) => candidate.id !== id), entry }
}

/** Deletes the entry by id — the per-row delete in the stash menu. */
export function removeStashEntryFrom(entries: PromptStashEntry[], id: string): PromptStashEntry[] {
  return entries.filter((candidate) => candidate.id !== id)
}

/** Whitespace-collapsed, truncated at 90 chars with an ellipsis; `(empty)`
 *  for a blank or whitespace-only entry. Ported from t3code's
 *  `ComposerStashMenu.tsx:17-24`, minus the image-count branch DevDeck's
 *  text-only entry has no use for. */
export function stashEntrySnippet(entry: PromptStashEntry): string {
  const trimmed = entry.text.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return '(empty)'
  return trimmed.length > SNIPPET_MAX_CHARS ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…` : trimmed
}
