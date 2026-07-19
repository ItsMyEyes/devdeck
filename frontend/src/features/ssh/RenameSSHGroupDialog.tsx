import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSSHConnections, useUpdateSSHConnection } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'

/** Bulk-renames every SSH connection currently tagged with `oldName` — a
 *  "group" has no id of its own (see the design spec), so renaming it means
 *  PATCHing every connection that shares the tag. */
export function RenameSSHGroupDialog() {
  const dialog = useDevDeckStore((s) => s.renameSSHGroup)
  const setValue = useDevDeckStore((s) => s.setRenameSSHGroupValue)
  const close = useDevDeckStore((s) => s.closeRenameSSHGroup)
  const showToast = useDevDeckStore((s) => s.showToast)
  const connections = useSSHConnections().data ?? []
  const updateConnection = useUpdateSSHConnection()

  const affected = useMemo(
    () => connections.filter((c) => c.group.trim() === dialog.oldName),
    [connections, dialog.oldName],
  )

  const trimmed = dialog.value.trim()
  const canSubmit = trimmed.length > 0 && trimmed !== dialog.oldName && !updateConnection.isPending

  async function submit() {
    if (!canSubmit) return
    try {
      await Promise.all(
        affected.map((connection) => updateConnection.mutateAsync({ id: connection.id, patch: { group: trimmed } })),
      )
      close()
      showToast(`Renamed group "${dialog.oldName}" to "${trimmed}"`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to rename group')
    }
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && close()} width={380}>
      <DialogTitle>Rename group</DialogTitle>
      <DialogDescription className="mb-4">
        Updates {affected.length} host{affected.length === 1 ? '' : 's'} currently tagged "{dialog.oldName}".
      </DialogDescription>
      <Label>Group name</Label>
      <Input
        value={dialog.value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder={dialog.oldName}
        className="mb-5 font-mono"
        autoFocus
      />
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={close}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {updateConnection.isPending ? 'Renaming…' : 'Rename'}
        </Button>
      </div>
    </Dialog>
  )
}
