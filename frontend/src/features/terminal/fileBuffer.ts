/**
 * The rule a file tab uses to decide whether it adopts the bytes the server
 * just handed it.
 *
 * ── Why this is not just `setDraft(file.data.content)` ──
 * It used to be `setDraft` exactly once, behind an `initialized` latch, and
 * that latch was not an oversight — see `EnvSettingsEditor.tsx`'s doc comment.
 * Binding a query's data straight to a Monaco `value` means a background
 * refetch calls `instance.setValue()` on top of whatever the operator is
 * mid-way through typing and discards it with no warning. The latch bought
 * safety by never looking at the server again, which cost the other half: a
 * file rewritten under an open tab — by an agent, a terminal, a `git checkout`,
 * another editor — stayed stale on screen until the tab was closed and
 * reopened.
 *
 * So the buffer carries a `baseline` — the server content the draft was last
 * reconciled against — and the two questions become separable:
 *
 *   draft === baseline   the operator has typed nothing since; whatever the
 *                        server says now is strictly better. Adopt it.
 *   draft !== baseline   there are unsaved edits. Hold them, and let the tab
 *                        say so (`hasExternalChange`) rather than pick a
 *                        winner on the operator's behalf.
 *
 * Everything here is pure so the rule is testable without a Monaco instance;
 * `FileEditor.tsx` and `SSHFileEditor.tsx` are the two callers, and they must
 * stay identical in this respect — a worktree file and an SFTP file differ in
 * where the bytes come from, not in what an unsaved edit is worth.
 */

export interface FileBuffer {
  /** What the editor shows, and what a save would write. */
  draft: string
  /** The server content `draft` was last reconciled against. NOT "the content
   *  on disk right now" — during a conflict this deliberately lags, and that
   *  lag is what `hasExternalChange` detects. */
  baseline: string
}

/** A buffer with no local edits, sitting exactly on `content`. */
export function seedBuffer(content: string): FileBuffer {
  return { draft: content, baseline: content }
}

/**
 * Folds a fresh server read into the buffer.
 *
 * Returns the SAME object when nothing should move, so a caller doing
 * `setBuffer((current) => syncBuffer(current, content))` re-renders only when
 * the buffer actually changed — a poll that finds the file untouched costs one
 * bailed-out state update and nothing else.
 */
export function syncBuffer(buffer: FileBuffer | null, incoming: string): FileBuffer {
  // First read: there is nothing to protect yet.
  if (!buffer) return seedBuffer(incoming)
  // The server is repeating itself.
  if (incoming === buffer.baseline) return buffer
  // No unsaved edits — adopting cannot lose anything.
  if (buffer.draft === buffer.baseline) return seedBuffer(incoming)
  // The server caught up with the draft: our own save landing, or something
  // else writing the identical bytes. Rebase the baseline so the buffer counts
  // as clean again — without this, one save would pin the baseline in the past
  // and every later external change would read as a conflict forever.
  if (buffer.draft === incoming) return seedBuffer(incoming)
  // Unsaved edits AND the file moved underneath them. Hold the draft.
  return buffer
}

/**
 * Records a local edit. Returns the same object for an unchanged draft (Monaco
 * echoes its own content back through `onChange`), and `null` stays `null`:
 * a change that arrives before the file has loaded is that echo of the empty
 * placeholder, and seeding a buffer from it would invent a conflict.
 */
export function editBuffer(buffer: FileBuffer | null, draft: string): FileBuffer | null {
  if (!buffer || buffer.draft === draft) return buffer
  return { draft, baseline: buffer.baseline }
}

/**
 * True when the file changed on disk and `syncBuffer` refused to adopt it —
 * i.e. exactly when the tab is holding unsaved edits over a newer file. This is
 * the one state the operator has to be told about, because it is the one state
 * where saving overwrites someone else's work.
 *
 * Defined in terms of `syncBuffer` rather than restating its conditions, so the
 * banner and the rule cannot drift apart.
 */
export function hasExternalChange(buffer: FileBuffer | null, incoming: string | undefined): boolean {
  if (!buffer || incoming === undefined) return false
  return incoming !== buffer.baseline && syncBuffer(buffer, incoming) === buffer
}
