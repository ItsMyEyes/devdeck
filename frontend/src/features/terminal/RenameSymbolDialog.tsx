import { useEffect, useState } from 'react'
import { FileWarning, Loader2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { RenamePlan } from './lsp/lspRename'

export interface RenameSymbolDialogProps {
  open: boolean
  /** The symbol the server says is being renamed. */
  symbol: string
  /** Set once the server has answered; switches the dialog to its confirm phase. */
  plan: RenamePlan | null
  pending: boolean
  currentPath: string
  onCancel: () => void
  /** Phase 1: ask the server what this rename would change. */
  onSubmitName: (newName: string) => void
  /** Phase 2: apply the plan. */
  onConfirmPlan: () => void
}

export function RenameSymbolDialog({
  open,
  symbol,
  plan,
  pending,
  currentPath,
  onCancel,
  onSubmitName,
  onConfirmPlan,
}: RenameSymbolDialogProps) {
  const [name, setName] = useState(symbol)

  // The dialog stays mounted between uses, so re-seed on each open or the
  // previous symbol's name sticks around.
  useEffect(() => {
    if (open) setName(symbol)
  }, [open, symbol])

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && trimmed !== symbol && !pending

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onCancel()} width={460} z={70}>
      <div className="mb-2.5 flex items-center gap-2.5">
        <Pencil size={15} className="text-devdeck-fg-2" />
        <DialogTitle>{plan ? 'Confirm rename' : `Rename ${symbol}`}</DialogTitle>
      </div>

      {plan ? (
        <>
          <DialogDescription className="mb-3 font-sans text-[12.5px] leading-[1.55] text-devdeck-fg-2">
            Renaming to <span className="font-mono text-devdeck-fg-2">{plan.newName}</span> changes{' '}
            {plan.otherFiles.length} other file{plan.otherFiles.length === 1 ? '' : 's'} on disk. Those writes
            happen immediately and cannot be undone from the editor.
          </DialogDescription>
          <ul className="mb-4 max-h-52 overflow-auto rounded border border-devdeck-border-strong bg-devdeck-glass-solid p-2 font-mono text-[11.5px]">
            {plan.currentEdits.length > 0 && (
              <li className="flex items-center justify-between px-1.5 py-1 text-devdeck-fg-2">
                <span className="truncate">{currentPath}</span>
                <span className="ml-3 shrink-0 text-devdeck-fg-2">
                  {plan.currentEdits.length} edit{plan.currentEdits.length === 1 ? '' : 's'} · unsaved
                </span>
              </li>
            )}
            {plan.otherFiles.map((file) => (
              <li key={file.path} className="flex items-center justify-between px-1.5 py-1 text-devdeck-fg-2">
                <span className="truncate">{file.path}</span>
                <span className="ml-3 shrink-0 text-devdeck-fg-2">
                  {file.edits.length} edit{file.edits.length === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2.5">
            <Button variant="secondary" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={onConfirmPlan} disabled={pending}>
              {pending ? <Loader2 size={12} className="animate-spin" /> : null}
              Rename {plan.otherFiles.length + (plan.currentEdits.length > 0 ? 1 : 0)} file
              {plan.otherFiles.length + (plan.currentEdits.length > 0 ? 1 : 0) === 1 ? '' : 's'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <DialogDescription className="mb-4 font-sans text-[12.5px] leading-[1.55] text-devdeck-fg-2">
            The language server decides which references change. You will see the full list before anything is
            written.
          </DialogDescription>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && canSubmit && onSubmitName(trimmed)}
            className="mb-5 font-mono"
            disabled={pending}
            autoFocus
          />
          <div className="flex justify-end gap-2.5">
            <Button variant="secondary" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => canSubmit && onSubmitName(trimmed)} disabled={!canSubmit}>
              {pending ? <Loader2 size={12} className="animate-spin" /> : <FileWarning size={12} />}
              Preview changes
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
