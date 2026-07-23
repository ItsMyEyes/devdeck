import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useCommitDBEdits, useDBConnections } from '@/features/data/queries'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'

export function DBCommitDialog() {
  const dialog = useDevDeckStore((s) => s.commitDialog)
  const close = useDevDeckStore((s) => s.closeCommitDialog)
  const showToast = useDevDeckStore((s) => s.showToast)
  const commit = useCommitDBEdits()
  const connections = useDBConnections().data ?? []
  const connection = connections.find((c) => c.id === dialog.connectionId)
  const [confirmedProduction, setConfirmedProduction] = useState(false)

  const needsProductionConfirm = connection?.isProduction && !confirmedProduction
  const busy = commit.isPending

  function run() {
    commit.mutate(
      { connectionId: dialog.connectionId, edits: dialog.edits },
      {
        onSuccess: (result) => {
          dialog.onCommitted?.()
          setConfirmedProduction(false)
          close()
          showToast(`Committed ${result.results.length} statement${result.results.length === 1 ? '' : 's'}`)
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            showToast('Another session changed one of these rows — reload the table and try again')
          } else {
            showToast(err instanceof Error ? err.message : 'Commit failed')
          }
        },
      },
    )
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={560}>
      <DialogTitle>Commit {dialog.edits.length} change{dialog.edits.length === 1 ? '' : 's'}</DialogTitle>
      <DialogDescription className="mb-3">
        Every row is matched against its current identity server-side before writing — this cannot be a stale write.
      </DialogDescription>

      <div className="mb-4 max-h-[280px] overflow-auto rounded-lg border border-devdeck-border-strong bg-devdeck-bg p-2.5">
        {dialog.edits.map((edit, i) => (
          <div key={i} className="mb-2 border-b border-devdeck-border-menu/50 pb-2 font-mono text-[11px] text-devdeck-fg-2 last:mb-0 last:border-0 last:pb-0">
            <div
              className={cn(
                'text-devdeck-dim',
                edit.kind === 'delete' && 'text-devdeck-red-soft',
                edit.kind === 'insert' && 'text-devdeck-green-soft',
              )}
            >
              {edit.kind.toUpperCase()} {edit.object.name}
            </div>
            {edit.newValues
              ? Object.entries(edit.newValues).map(([col, val]) => (
                  <div key={col}>
                    {col}: <span className="text-devdeck-yellow-tint-text">{String(val)}</span>
                  </div>
                ))
              : null}
            {edit.kind === 'delete' && edit.oldValues
              ? Object.entries(edit.oldValues).map(([col, val]) => (
                  <div key={col}>
                    {col}: <span className="text-devdeck-red-soft">{val === null ? 'null' : String(val)}</span>
                  </div>
                ))
              : null}
          </div>
        ))}
      </div>

      {connection?.isProduction ? (
        <label className="mb-4 flex items-center gap-2 rounded-lg border border-devdeck-yellow-tint-border bg-devdeck-yellow-tint p-2.5 text-[11.5px] text-devdeck-yellow-tint-text">
          <input type="checkbox" checked={confirmedProduction} onChange={(e) => setConfirmedProduction(e.target.checked)} />
          This connection is marked production — I want to apply this commit.
        </label>
      ) : null}

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={run} disabled={busy || needsProductionConfirm}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          Commit
        </Button>
      </div>
    </Dialog>
  )
}
