import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCreateMachine, useUpdateMachine } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

export function MachineDialog() {
  const dialog = useLoomStore((s) => s.machineDialog)
  const setDialog = useLoomStore((s) => s.setMachineDialog)
  const close = useLoomStore((s) => s.closeMachineDialog)
  const showToast = useLoomStore((s) => s.showToast)
  const createMachine = useCreateMachine()
  const updateMachine = useUpdateMachine()

  const isEdit = dialog.editingId !== null
  const busy = createMachine.isPending || updateMachine.isPending
  const canSubmit = dialog.name.trim().length > 0 && dialog.url.trim().length > 0 && dialog.key.trim().length > 0 && !busy

  function submit() {
    if (!canSubmit) return
    const body = { name: dialog.name.trim(), url: dialog.url.trim(), key: dialog.key.trim() }
    if (isEdit && dialog.editingId) {
      updateMachine.mutate(
        { id: dialog.editingId, patch: body },
        {
          onSuccess: () => {
            close()
            showToast(`Updated machine "${body.name}"`)
          },
          onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to update machine'),
        },
      )
      return
    }
    createMachine.mutate(body, {
      onSuccess: () => {
        close()
        showToast(`Added machine "${body.name}"`)
      },
      onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to add machine'),
    })
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={480}>
      <DialogTitle>{isEdit ? 'Edit machine' : 'Add machine'}</DialogTitle>
      <DialogDescription className="mb-[18px]">
        Runtime machines run worktrees, terminals, and git — reachable over your tailnet.
      </DialogDescription>

      <Label>Name</Label>
      <Input
        value={dialog.name}
        disabled={busy}
        onChange={(e) => setDialog({ name: e.target.value })}
        placeholder="builder"
        className="mb-3 font-mono"
      />

      <Label>URL</Label>
      <Input
        value={dialog.url}
        disabled={busy}
        onChange={(e) => setDialog({ url: e.target.value })}
        placeholder="https://builder.tail-x.ts.net:8989"
        className="mb-3 font-mono"
      />

      <Label>Key</Label>
      <Input
        value={dialog.key}
        disabled={busy}
        type="password"
        onChange={(e) => setDialog({ key: e.target.value })}
        placeholder="runtime --key value"
        className="mb-5 font-mono"
      />

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          {isEdit ? 'Save' : 'Add machine →'}
        </Button>
      </div>
    </Dialog>
  )
}
