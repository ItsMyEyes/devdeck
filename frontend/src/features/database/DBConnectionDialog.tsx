import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import {
  useCreateDBConnection,
  useDBConnections,
  useDeleteDBConnection,
  useSSHConnections,
  useTestDBConnection,
  useUpdateDBConnection,
} from '@/features/data/queries'
import type { CreateDBConnectionBody, UpdateDBConnectionBody } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { DBEngine } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const ENGINE_OPTIONS: { value: DBEngine; label: string }[] = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL / MariaDB' },
  { value: 'sqlite', label: 'SQLite' },
]

const PG_SSL_OPTIONS = [
  { value: 'disable', label: 'disable — unencrypted' },
  { value: 'prefer', label: 'prefer — unverified' },
  { value: 'require', label: 'require — encrypted, unverified' },
  { value: 'verify-ca', label: 'verify-ca' },
  { value: 'verify-full', label: 'verify-full (recommended)' },
]

const MYSQL_SSL_OPTIONS = [
  { value: 'false', label: 'false — unencrypted' },
  { value: 'preferred', label: 'preferred — unverified' },
  { value: 'skip-verify', label: 'skip-verify — encrypted, unverified' },
  { value: 'verify-ca', label: 'verify-ca' },
  { value: 'verify-identity', label: 'verify-identity (recommended)' },
]

const NO_TUNNEL = ''

function defaultPort(engine: DBEngine) {
  return engine === 'mysql' ? '3306' : engine === 'postgres' ? '5432' : ''
}

export function DBConnectionDialog() {
  const dialog = useDevDeckStore((s) => s.dbDialog)
  const setDialog = useDevDeckStore((s) => s.setDBDialog)
  const close = useDevDeckStore((s) => s.closeDBDialog)
  const showToast = useDevDeckStore((s) => s.showToast)
  const setConnectionTestStatus = useDevDeckStore((s) => s.setDBConnectionTestStatus)
  const createConnection = useCreateDBConnection()
  const updateConnection = useUpdateDBConnection()
  const deleteConnection = useDeleteDBConnection()
  const testConnection = useTestDBConnection()
  const connections = useDBConnections().data ?? []
  const sshConnections = useSSHConnections().data ?? []
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; reason?: string } | null>(null)

  const isEdit = dialog.editingId !== null
  const isSqlite = dialog.engine === 'sqlite'
  const busy = createConnection.isPending || updateConnection.isPending || deleteConnection.isPending
  const portNum = Number.parseInt(dialog.port, 10)
  const portOK = isSqlite || (Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535)
  const canSubmit =
    dialog.name.trim().length > 0 &&
    (isSqlite ? dialog.database.trim().length > 0 : dialog.host.trim().length > 0) &&
    portOK &&
    !busy

  const groupOptions = Array.from(new Set(connections.map((c) => c.group.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  )
  const tunnelOptions = [
    { value: NO_TUNNEL, label: 'Direct connection' },
    ...sshConnections.map((c) => ({ value: c.id, label: c.name })),
  ]
  const sslOptions = dialog.engine === 'mysql' ? MYSQL_SSL_OPTIONS : PG_SSL_OPTIONS

  function onEngineChange(engine: DBEngine) {
    setDialog({ engine, port: defaultPort(engine), sslMode: engine === 'mysql' ? 'verify-identity' : 'verify-full' })
  }

  async function runTest() {
    if (!dialog.editingId) {
      showToast('Save the connection once before testing it')
      return
    }
    setTestResult(null)
    const result = await testConnection.mutateAsync(dialog.editingId)
    setTestResult(result)
    setConnectionTestStatus(dialog.editingId, result.ok)
  }

  function submit() {
    if (!canSubmit) return
    const base: CreateDBConnectionBody = {
      name: dialog.name.trim(),
      group: dialog.group.trim(),
      engine: dialog.engine,
      host: isSqlite ? '' : dialog.host.trim(),
      port: isSqlite ? undefined : portNum,
      username: isSqlite ? '' : dialog.username.trim(),
      database: dialog.database.trim(),
      sslMode: isSqlite ? '' : dialog.sslMode,
      executorMachineId: dialog.executorMachineId || null,
      tunnelConnectionId: dialog.tunnelConnectionId || null,
      isProduction: dialog.isProduction,
    }
    const secrets: UpdateDBConnectionBody = {}
    if (dialog.password) secrets.password = dialog.password
    if (dialog.caCert) secrets.caCert = dialog.caCert
    if (dialog.clientCert) secrets.clientCert = dialog.clientCert
    if (dialog.clientKey) secrets.clientKey = dialog.clientKey

    const onError = (err: unknown) => showToast(err instanceof Error ? err.message : 'Failed to save database connection')

    if (dialog.editingId) {
      updateConnection.mutate(
        { id: dialog.editingId, patch: { ...base, ...secrets } },
        { onSuccess: () => { close(); showToast(`Updated connection "${base.name}"`) }, onError },
      )
    } else {
      createConnection.mutate(
        { ...base, ...secrets },
        { onSuccess: () => { close(); showToast(`Added connection "${base.name}"`) }, onError },
      )
    }
  }

  function confirmDelete() {
    if (!dialog.editingId) return
    deleteConnection.mutate(dialog.editingId, {
      onSuccess: () => { close(); showToast(`Deleted connection "${dialog.name}"`) },
      onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to delete connection'),
    })
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={520}>
      <DialogTitle>{isEdit ? 'Edit database connection' : 'New database connection'}</DialogTitle>
      <DialogDescription className="mb-[18px]">
        Credentials are encrypted at rest and never sent back to the browser.
      </DialogDescription>

      <Label>Name</Label>
      <Input value={dialog.name} disabled={busy} onChange={(e) => setDialog({ name: e.target.value })} placeholder="prod-postgres" className="mb-3 font-mono" />

      <Label>Group</Label>
      <Combobox value={dialog.group} onChange={(group) => setDialog({ group })} options={groupOptions} disabled={busy} placeholder="Production" className="mb-3" />

      <Label>Engine</Label>
      <Select value={dialog.engine} onValueChange={(v) => onEngineChange(v as DBEngine)} options={ENGINE_OPTIONS} disabled={busy || isEdit} aria-label="Engine" className="mb-3" />

      {isSqlite ? (
        <>
          <Label>Database file path</Label>
          <Input value={dialog.database} disabled={busy} onChange={(e) => setDialog({ database: e.target.value })} placeholder="/path/to/app.db" className="mb-3 font-mono" />
        </>
      ) : (
        <>
          <div className="mb-3 flex gap-3">
            <div className="min-w-0 flex-1">
              <Label>Host</Label>
              <Input value={dialog.host} disabled={busy} onChange={(e) => setDialog({ host: e.target.value })} placeholder="db.example.com" className="font-mono" />
            </div>
            <div className="w-[90px] flex-none">
              <Label>Port</Label>
              <Input value={dialog.port} disabled={busy} onChange={(e) => setDialog({ port: e.target.value })} className="font-mono" />
            </div>
          </div>
          <Label>Username</Label>
          <Input value={dialog.username} disabled={busy} onChange={(e) => setDialog({ username: e.target.value })} className="mb-3 font-mono" />
          <Label>Database</Label>
          <Input value={dialog.database} disabled={busy} onChange={(e) => setDialog({ database: e.target.value })} className="mb-3 font-mono" />
          <Label>Password</Label>
          <Input
            value={dialog.password}
            disabled={busy}
            type="password"
            onChange={(e) => setDialog({ password: e.target.value })}
            placeholder={isEdit ? 'unchanged' : ''}
            className="mb-3 font-mono"
          />
          <Label>TLS mode</Label>
          <Select value={dialog.sslMode} onValueChange={(v) => setDialog({ sslMode: v })} options={sslOptions} disabled={busy} aria-label="TLS mode" className="mb-3" />
        </>
      )}

      <label className="mb-3 flex items-center gap-2 text-[12px] text-devdeck-fg">
        <input type="checkbox" checked={dialog.isProduction} disabled={busy} onChange={(e) => setDialog({ isProduction: e.target.checked })} />
        Production — colors this connection's tabs, forces extra confirmation on commits and DDL, and (for postgres/mysql) rejects an unverified TLS mode
      </label>

      {!isSqlite ? (
        <div className="mb-5 rounded-[12px] border border-devdeck-border-card bg-devdeck-surface-2 p-3">
          <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-devdeck-dim">SSH tunnel</div>
          <Select value={dialog.tunnelConnectionId} onValueChange={(v) => setDialog({ tunnelConnectionId: v })} options={tunnelOptions} disabled={busy} aria-label="SSH tunnel" />
          <p className="mt-1.5 text-[11px] leading-snug text-devdeck-dim">
            {dialog.tunnelConnectionId ? 'The executor tunnels through this SSH connection to reach the database.' : 'The executor dials the database directly.'}
          </p>
        </div>
      ) : null}

      {isEdit ? (
        <div className="mb-5 flex items-center gap-2.5">
          <Button variant="secondary" size="sm" onClick={runTest} disabled={testConnection.isPending}>
            {testConnection.isPending && <Loader2 size={13} className="animate-spin" />}
            Test connection
          </Button>
          {testResult ? (
            <span className={cn('text-[11.5px]', testResult.ok ? 'text-devdeck-green-soft' : 'text-devdeck-red-soft')}>
              {testResult.ok ? 'Connected' : testResult.reason}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2.5">
        {isEdit ? (
          confirmingDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-[11.5px] text-devdeck-red-soft">Delete "{dialog.name}"?</span>
              <Button variant="destructive-solid" size="sm" onClick={confirmDelete} disabled={busy}>
                Confirm
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="destructive" size="sm" onClick={() => setConfirmingDelete(true)} disabled={busy}>
              Delete
            </Button>
          )
        ) : (
          <span />
        )}
        <div className="flex gap-2.5">
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {isEdit ? 'Save' : 'Add'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
