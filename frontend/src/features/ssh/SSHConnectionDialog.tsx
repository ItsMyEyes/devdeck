import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useCreateSSHConnection, useUpdateSSHConnection } from '@/features/data/queries'
import type { CreateSSHConnectionBody, UpdateSSHConnectionBody } from '@/lib/api'
import { useLoomStore } from '@/store/useLoomStore'

const AUTH_OPTIONS = [
  { value: 'password', label: 'Password' },
  { value: 'privatekey', label: 'Private key' },
]

export function SSHConnectionDialog() {
  const dialog = useLoomStore((s) => s.sshDialog)
  const setDialog = useLoomStore((s) => s.setSSHDialog)
  const close = useLoomStore((s) => s.closeSSHDialog)
  const showToast = useLoomStore((s) => s.showToast)
  const createConnection = useCreateSSHConnection()
  const updateConnection = useUpdateSSHConnection()

  const isEdit = dialog.editingId !== null
  const busy = createConnection.isPending || updateConnection.isPending
  const portNum = Number.parseInt(dialog.port, 10)
  const portOK = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535
  // On create the auth secret is required; on edit a blank secret means "keep the stored one".
  const secretOK =
    isEdit || (dialog.authType === 'password' ? dialog.password.length > 0 : dialog.privateKey.length > 0)
  const canSubmit =
    dialog.name.trim().length > 0 &&
    dialog.host.trim().length > 0 &&
    dialog.username.trim().length > 0 &&
    portOK &&
    secretOK &&
    !busy

  function submit() {
    if (!canSubmit) return
    const base = {
      name: dialog.name.trim(),
      host: dialog.host.trim(),
      port: portNum,
      username: dialog.username.trim(),
      authType: dialog.authType,
    }
    const secrets: UpdateSSHConnectionBody = {}
    if (dialog.password) secrets.password = dialog.password
    if (dialog.privateKey) secrets.privateKey = dialog.privateKey
    if (dialog.passphrase) secrets.passphrase = dialog.passphrase

    const onError = (err: unknown) =>
      showToast(err instanceof Error ? err.message : 'Failed to save SSH connection')

    if (dialog.editingId) {
      updateConnection.mutate(
        { id: dialog.editingId, patch: { ...base, ...secrets } },
        {
          onSuccess: () => {
            close()
            showToast(`Updated SSH connection "${base.name}"`)
          },
          onError,
        },
      )
    } else {
      const body: CreateSSHConnectionBody = { ...base, ...secrets }
      createConnection.mutate(body, {
        onSuccess: () => {
          close()
          showToast(`Added SSH connection "${base.name}"`)
        },
        onError,
      })
    }
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={480}>
      <DialogTitle>{isEdit ? 'Edit SSH connection' : 'Add SSH connection'}</DialogTitle>
      <DialogDescription className="mb-[18px]">
        Any SSH host — not limited to registered machines. Credentials are encrypted at rest and never sent back
        to the browser.
      </DialogDescription>

      <Label>Name</Label>
      <Input
        value={dialog.name}
        disabled={busy}
        onChange={(e) => setDialog({ name: e.target.value })}
        placeholder="prod-web"
        className="mb-3 font-mono"
      />

      <div className="mb-3 flex gap-3">
        <div className="min-w-0 flex-1">
          <Label>Host</Label>
          <Input
            value={dialog.host}
            disabled={busy}
            onChange={(e) => setDialog({ host: e.target.value })}
            placeholder="web.example.com"
            className="font-mono"
          />
        </div>
        <div className="w-[90px] flex-none">
          <Label>Port</Label>
          <Input
            value={dialog.port}
            disabled={busy}
            onChange={(e) => setDialog({ port: e.target.value })}
            placeholder="22"
            className="font-mono"
          />
        </div>
      </div>

      <Label>Username</Label>
      <Input
        value={dialog.username}
        disabled={busy}
        onChange={(e) => setDialog({ username: e.target.value })}
        placeholder="deploy"
        className="mb-3 font-mono"
      />

      <Label>Auth</Label>
      <Select
        value={dialog.authType}
        onValueChange={(v) => setDialog({ authType: v as 'password' | 'privatekey' })}
        options={AUTH_OPTIONS}
        aria-label="Auth method"
      />

      {dialog.authType === 'password' ? (
        <div className="mt-3">
          <Label>Password</Label>
          <Input
            value={dialog.password}
            disabled={busy}
            type="password"
            onChange={(e) => setDialog({ password: e.target.value })}
            placeholder={isEdit ? 'unchanged' : ''}
            className="mb-5 font-mono"
          />
        </div>
      ) : (
        <div className="mt-3">
          <Label>Private key (PEM)</Label>
          <textarea
            value={dialog.privateKey}
            disabled={busy}
            onChange={(e) => setDialog({ privateKey: e.target.value })}
            placeholder={isEdit ? 'unchanged' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
            rows={4}
            className="mb-3 w-full resize-y rounded-lg border border-loom-border-strong bg-loom-bg px-2.5 py-2 font-mono text-[11px] text-loom-fg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <Label>Passphrase (optional)</Label>
          <Input
            value={dialog.passphrase}
            disabled={busy}
            type="password"
            onChange={(e) => setDialog({ passphrase: e.target.value })}
            placeholder={isEdit ? 'unchanged' : ''}
            className="mb-5 font-mono"
          />
        </div>
      )}

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          {isEdit ? 'Save' : 'Add'}
        </Button>
      </div>
    </Dialog>
  )
}
