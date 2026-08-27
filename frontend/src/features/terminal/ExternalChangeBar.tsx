import { FileWarning } from 'lucide-react'

/**
 * Shown when a file tab is holding unsaved edits over a file that has since
 * changed on disk — `fileBuffer.ts`'s `hasExternalChange`, which is the exact
 * case the buffer refuses to reconcile on its own.
 *
 * Deliberately not a dialog and not a toast. The tab has already done the safe
 * thing (kept the operator's edits), so nothing is blocked and nothing is
 * urgent; what is missing is the knowledge that saving from here would
 * overwrite whatever the agent just wrote. That belongs pinned to the buffer it
 * describes, not floating over the app and not gone in four seconds.
 *
 * "Reload" is the editor's own revert path, so discarding is one action with
 * one implementation rather than two that can disagree.
 */
export function ExternalChangeBar({ onReload }: { onReload: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1 border-b border-devdeck-border bg-devdeck-card px-3 py-1.5 text-[11px] text-devdeck-fg-2"
    >
      <FileWarning size={13} aria-hidden="true" className="flex-none text-devdeck-yellow" />
      <span>This file changed on disk. Your unsaved edits are still here — saving will overwrite the new version.</span>
      <button
        type="button"
        onClick={onReload}
        className="rounded border border-devdeck-border-strong px-2 py-0.5 text-devdeck-fg transition-colors hover:bg-devdeck-hover-wash"
      >
        Reload from disk
      </button>
    </div>
  )
}
