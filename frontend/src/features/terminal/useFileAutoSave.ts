import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useAutoSaveSetting } from '@/features/editor/useAutoSaveSetting'

/** Trailing debounce. Long enough that a burst of typing is one write rather
 *  than one per keystroke, short enough that the still-dirty window a close
 *  prompt has to cover stays under a second. */
export const AUTO_SAVE_DELAY_MS = 800

export interface FileAutoSaveOptions {
  /** False until the file's real content has loaded. Writing before then would
   *  put the empty placeholder on disk. `FileEditor`'s `initialized`. */
  ready: boolean
  /** Whether this tab is the visible one in its pane. Only the true->false edge
   *  is used, as a flush point — tabs stay mounted when they go to the back. */
  active: boolean
  dirty: boolean
  /** The current draft. Never read: it is the debounce's re-arm signal, so each
   *  keystroke pushes the write out instead of queueing one of its own. */
  draft: string
  /** `fileBuffer.hasExternalChange` — the file moved on disk underneath unsaved
   *  edits. See the module doc for why that stands auto-save down. */
  conflicted: boolean
  /** The owning editor's `saveNow`, silenced. Rejects if the write fails. */
  save: () => Promise<void>
  delayMs?: number
}

/**
 * Writes a file tab's draft without being asked.
 *
 * A file tab only ever reached disk through Ctrl+S or the "Save changes?"
 * prompt on close, which meant an edit survived exactly as long as the operator
 * remembered it existed. Switch project, close a pane from muscle memory, or
 * quit the app, and it was gone. So the draft is now written on a trailing
 * debounce while typing and flushed outright at every point the buffer can
 * leave the screen: the tab going to the back, the app losing focus or being
 * hidden, and unmount.
 *
 * Two things it deliberately refuses to write:
 *
 *  - **A conflicted buffer.** When `hasExternalChange` is true the file changed
 *    on disk under unsaved edits — usually an agent writing the same file — and
 *    an unattended write would destroy that with nobody watching. The tab
 *    already shows `ExternalChangeBar`; auto-save stands down until the
 *    operator picks a side, which is the same "don't pick a winner for them"
 *    rule `fileBuffer.ts` is built on.
 *  - **An abandoned draft.** "Don't Save" and "the file was deleted" both
 *    unmount a tab that is still dirty, and the unmount flush would resurrect
 *    precisely what the operator just discarded. The returned `discard` is the
 *    veto for that.
 *
 * Returns `discard`: cancels the pending write and disarms every flush path for
 * the rest of this tab's life. It is imperative rather than a prop for a reason
 * — the tab unmounts in the *same commit* as the decision to discard it, so a
 * state update announcing that would be thrown away before the unmount flush
 * could ever read it. A ref write lands immediately.
 */
export function useFileAutoSave({
  ready,
  active,
  dirty,
  draft,
  conflicted,
  save,
  delayMs = AUTO_SAVE_DELAY_MS,
}: FileAutoSaveOptions): () => void {
  const [enabled] = useAutoSaveSetting()

  // The flush paths below are registered once and fire from listeners and from
  // an unmount cleanup, so they cannot close over props that change on every
  // keystroke. Committed in an effect rather than during render so what an
  // unmount flush reads is the last state React actually committed.
  const latest = useRef({ enabled, ready, dirty, conflicted, save })
  useEffect(() => {
    latest.current = { enabled, ready, dirty, conflicted, save }
  })

  const abandoned = useRef(false)
  const inFlight = useRef(false)
  const queued = useRef(false)
  const failed = useRef(false)

  const flush = useCallback(function flush() {
    const current = latest.current
    if (abandoned.current) return
    if (!current.enabled || !current.ready || !current.dirty || current.conflicted) return
    if (inFlight.current) {
      // A write is already on the wire carrying older bytes. Queue exactly one
      // pass behind it rather than racing two PUTs at the same path, where the
      // loser could land last and put the older draft back.
      queued.current = true
      return
    }
    inFlight.current = true
    void current
      .save()
      .then(
        () => {
          failed.current = false
        },
        (error: unknown) => {
          // One toast per failing streak. A read-only file or a dropped SSH
          // connection fails every attempt, and an unattended save raising a
          // toast per typing burst is worse than the thing it is reporting.
          if (failed.current) return
          failed.current = true
          toast.error(error instanceof Error ? error.message : 'Auto-save failed')
        },
      )
      .finally(() => {
        inFlight.current = false
        if (!queued.current) return
        queued.current = false
        flush()
      })
    // `save` is read off the ref, so this stays stable for the life of the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!enabled || !ready || !dirty || conflicted) return
    const timer = window.setTimeout(flush, delayMs)
    return () => window.clearTimeout(timer)
    // `draft` re-arms the timer on every keystroke — that is what makes this a
    // trailing debounce rather than a save per edit. It is intentionally a
    // dependency the body never reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ready, dirty, conflicted, draft, delayMs, flush])

  // Tab pushed to the back of its pane. Not an unmount — `ExpandedTerminal`
  // keeps every open file mounted and hides it with `display: none` — so
  // without this the draft would sit in memory behind another tab, out of sight
  // and unwritten, which is the exact shape of the edit that goes missing.
  const wasActive = useRef(active)
  useEffect(() => {
    const leftScreen = wasActive.current && !active
    wasActive.current = active
    if (leftScreen) flush()
  }, [active, flush])

  // App switched away from or quit. `blur` is the one that fires on a desktop
  // Cmd+Tab; `visibilitychange` covers a hidden window and a backgrounded
  // browser tab. Both are no-ops on a clean buffer, so the extra listeners cost
  // nothing on the tabs that are not dirty.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [flush])

  // Unmount: tab closed, pane closed, or the whole workspace navigated away
  // from. The write still lands — the mutation is executed by the app-level
  // query client, not by this component — so the bytes reach disk even though
  // nothing is left to re-render with the result.
  useEffect(() => () => flush(), [flush])

  return useCallback(() => {
    abandoned.current = true
    queued.current = false
  }, [])
}
