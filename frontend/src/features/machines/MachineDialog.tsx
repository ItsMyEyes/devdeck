import { Copy, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUpdateMachine } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

/** 32 random bytes as 64 lowercase hex chars — mirrors the desktop sidecar's generate_key(). */
function generateRuntimeKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function runtimeCommand(key: string, name: string): string {
  const hubUrl = window.location.origin
  return [
    `./loom.exe --role runtime --key ${key} --addr 0.0.0.0:9199 --db runtime.db --open=false \\`,
    `  --hub-url ${hubUrl} --hub-key <your-hub-key> --public-url http://<hostname>:9199 --name ${name.trim() || '<name>'}`,
  ].join('\n')
}

export function MachineDialog() {
  const dialog = useLoomStore((s) => s.machineDialog)
  const setDialog = useLoomStore((s) => s.setMachineDialog)
  const close = useLoomStore((s) => s.closeMachineDialog)
  const showToast = useLoomStore((s) => s.showToast)
  const updateMachine = useUpdateMachine()

  const isEdit = dialog.editingId !== null
  const busy = updateMachine.isPending
  const canSubmit = dialog.name.trim().length > 0 && dialog.url.trim().length > 0 && dialog.key.trim().length > 0 && !busy

  const [runtimeKey, setRuntimeKey] = useState('')
  useEffect(() => {
    if (dialog.open && !isEdit) setRuntimeKey(generateRuntimeKey())
  }, [dialog.open, isEdit])

  function copyCommand() {
    void navigator.clipboard.writeText(runtimeCommand(runtimeKey, dialog.name))
    toast.success('Command copied')
  }

  function submit() {
    if (!canSubmit || !dialog.editingId) return
    const body = { name: dialog.name.trim(), url: dialog.url.trim(), key: dialog.key.trim() }
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

      {isEdit ? (
        <>
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
        </>
      ) : (
        <>
          <Label>Runtime command</Label>
          <p className="mb-2 font-mono text-[10.5px] text-loom-dim-2">
            Run this on the target machine — replace &lt;your-hub-key&gt; and &lt;hostname&gt;. It self-registers with
            this hub on startup.
          </p>
          <div className="relative mb-5 rounded-lg border border-loom-border-card bg-loom-terminal p-2.5 pr-9">
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-loom-fg">
              {runtimeCommand(runtimeKey, dialog.name)}
            </pre>
            <button
              type="button"
              onClick={copyCommand}
              aria-label="Copy command"
              className="absolute right-2.5 top-2.5 cursor-pointer p-1 text-loom-muted-2 hover:text-loom-accent-soft"
            >
              <Copy size={12} />
            </button>
          </div>
        </>
      )}

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={close} disabled={busy}>
          {isEdit ? 'Cancel' : 'Close'}
        </Button>
        {isEdit ? (
          <Button onClick={submit} disabled={!canSubmit}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            Save
          </Button>
        ) : (
          <Button onClick={copyCommand}>
            <Copy size={13} />
            Copy command
          </Button>
        )}
      </div>
    </Dialog>
  )
}
