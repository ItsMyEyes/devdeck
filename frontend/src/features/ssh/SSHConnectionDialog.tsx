import { useEffect, useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { SideDrawer } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import {
  useCreateSSHConnection,
  useMachines,
  useMachinesHealth,
  useSSHConnections,
  useUpdateSSHConnection,
} from '@/features/data/queries'
import type { CreateSSHConnectionBody, UpdateSSHConnectionBody } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { buildJumpHostRequest, defaultJumpHostDraft, isJumpHostDraftValid } from './jumpHostDraft'
import { SSHAuthFields } from './SSHAuthFields'

const HUB_DECIDES = ''
const DIRECT = ''
const ADD_NEW_JUMP = '__new__'

export function SSHConnectionDialog() {
  const dialog = useDevDeckStore((s) => s.sshDialog)
  const setDialog = useDevDeckStore((s) => s.setSSHDialog)
  const close = useDevDeckStore((s) => s.closeSSHDialog)
  const showToast = useDevDeckStore((s) => s.showToast)
  const createConnection = useCreateSSHConnection()
  const updateConnection = useUpdateSSHConnection()
  const machines = useMachines().data ?? []
  const machineHealth = useMachinesHealth(machines)
  const connections = useSSHConnections().data ?? []
  const [addingJump, setAddingJump] = useState(false)
  const [jumpDraft, setJumpDraft] = useState(defaultJumpHostDraft())

  useEffect(() => {
    if (!dialog.open) setAddingJump(false)
  }, [dialog.open])

  const groupOptions = useMemo(
    () => Array.from(new Set(connections.map((c) => c.group.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [connections],
  )
  const isEdit = dialog.editingId !== null
  const busy = createConnection.isPending || updateConnection.isPending
  const portNum = Number.parseInt(dialog.port, 10)
  const portOK = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535
  // On create the auth secret is required; on edit a blank secret means "keep the stored one".
  const secretOK =
    isEdit || (dialog.authType === 'password' ? dialog.password.length > 0 : Boolean(dialog.privateKey || dialog.privateKeyPath))
  const canSubmit =
    dialog.name.trim().length > 0 &&
    dialog.host.trim().length > 0 &&
    dialog.username.trim().length > 0 &&
    portOK &&
    secretOK &&
    !addingJump &&
    !busy

  const machineOptions = [
    { value: HUB_DECIDES, label: 'Hub decides' },
    ...machines.map((m) => ({
      value: m.id,
      label: m.isLocal ? `${m.name} (local)` : m.name,
      disabled: machineHealth.get(m.id)?.status === 'offline',
    })),
  ]
  // A connection can't jump through itself. The backend re-validates the
  // full chain authoritatively (including deeper cycles); this just keeps
  // the one obviously-cyclic choice out of the list.
  const jumpOptions = [
    { value: DIRECT, label: 'Direct connection' },
    { value: ADD_NEW_JUMP, label: '+ Add new jump host…' },
    ...connections.filter((c) => c.id !== dialog.editingId).map((c) => ({ value: c.id, label: c.name })),
  ]

  function handleJumpChange(value: string) {
    if (value === ADD_NEW_JUMP) {
      setJumpDraft(defaultJumpHostDraft())
      setAddingJump(true)
      return
    }
    setAddingJump(false)
    setDialog({ jumpConnectionId: value })
  }

  function cancelAddJump() {
    setAddingJump(false)
  }

  function createJumpHost() {
    if (!isJumpHostDraftValid(jumpDraft) || busy) return
    createConnection.mutate(buildJumpHostRequest(jumpDraft), {
      onSuccess: (created) => {
        setDialog({ jumpConnectionId: created.id })
        setAddingJump(false)
        showToast(`Added jump host "${created.name}"`)
      },
      onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to add jump host'),
    })
  }

  function submit() {
    if (!canSubmit) return
    const base: CreateSSHConnectionBody = {
      name: dialog.name.trim(),
      group: dialog.group.trim(),
      host: dialog.host.trim(),
      port: portNum,
      username: dialog.username.trim(),
      authType: dialog.authType,
      executorMachineId: dialog.executorMachineId || null,
      jumpConnectionId: dialog.jumpConnectionId || null,
    }
    const secrets: UpdateSSHConnectionBody = {}
    if (dialog.password) secrets.password = dialog.password
    if (dialog.privateKey) secrets.privateKey = dialog.privateKey
    else if (dialog.privateKeyPath) secrets.privateKeyPath = dialog.privateKeyPath
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
    <SideDrawer open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={460} z={55}>
      {/* header */}
      <div className="flex flex-none items-start gap-2.5 border-b border-devdeck-border px-[18px] pb-3.5 pt-[18px]">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-devdeck-fg">
            {isEdit ? 'Edit SSH connection' : 'Add SSH connection'}
          </div>
          <div className="mt-1 font-mono text-[11px] text-devdeck-dim">
            Any SSH host — not limited to registered machines. Credentials are encrypted at rest and never sent
            back to the browser.
          </div>
        </div>
        <button
          onClick={close}
          disabled={busy}
          aria-label="Close"
          className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md border border-devdeck-border-strong text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-fg disabled:opacity-50"
        >
          <X size={14} />
        </button>
      </div>

      {/* body */}
      <div className="flex-1 overflow-auto p-[18px]">
        <Label>Name</Label>
        <Input
          value={dialog.name}
          disabled={busy}
          onChange={(e) => setDialog({ name: e.target.value })}
          placeholder="prod-web"
          className="mb-3 font-mono"
        />

        <Label>Group</Label>
        <Combobox
          value={dialog.group}
          onChange={(group) => setDialog({ group })}
          options={groupOptions}
          disabled={busy}
          placeholder="Production"
          className="mb-3"
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

        <SSHAuthFields
          authType={dialog.authType}
          password={dialog.password}
          privateKey={dialog.privateKey}
          privateKeyPath={dialog.privateKeyPath}
          passphrase={dialog.passphrase}
          onChange={(patch) => setDialog(patch)}
          disabled={busy}
          isEdit={isEdit}
        />

        <div className="rounded-[12px] border border-devdeck-border-card bg-devdeck-surface-2 p-3">
          <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-devdeck-dim">Connection flow</div>

          <Label>1. Executor machine</Label>
          <Select
            value={dialog.executorMachineId}
            onValueChange={(v) => setDialog({ executorMachineId: v })}
            options={machineOptions}
            disabled={busy}
            aria-label="Executor machine"
            className="mb-3"
          />

          <Label>2. Connect via</Label>
          <Select
            value={addingJump ? ADD_NEW_JUMP : dialog.jumpConnectionId}
            onValueChange={handleJumpChange}
            options={jumpOptions}
            disabled={busy}
            aria-label="Connect via"
          />
          {addingJump ? (
            <div className="mt-2 rounded-lg border border-devdeck-border-strong bg-devdeck-bg p-2.5">
              <Label>Host</Label>
              <Input
                value={jumpDraft.host}
                disabled={busy}
                onChange={(e) => setJumpDraft((d) => ({ ...d, host: e.target.value }))}
                placeholder="bastion.example.com"
                className="mb-2.5 font-mono"
              />
              <div className="mb-2.5 flex gap-3">
                <div className="min-w-0 flex-1">
                  <Label>Username</Label>
                  <Input
                    value={jumpDraft.username}
                    disabled={busy}
                    onChange={(e) => setJumpDraft((d) => ({ ...d, username: e.target.value }))}
                    placeholder="deploy"
                    className="font-mono"
                  />
                </div>
                <div className="w-[90px] flex-none">
                  <Label>Port</Label>
                  <Input
                    value={jumpDraft.port}
                    disabled={busy}
                    onChange={(e) => setJumpDraft((d) => ({ ...d, port: e.target.value }))}
                    placeholder="22"
                    className="font-mono"
                  />
                </div>
              </div>
              <SSHAuthFields
                authType={jumpDraft.authType}
                password={jumpDraft.password}
                privateKey={jumpDraft.privateKey}
                privateKeyPath={jumpDraft.privateKeyPath}
                passphrase={jumpDraft.passphrase}
                onChange={(patch) => setJumpDraft((d) => ({ ...d, ...patch }))}
                disabled={busy}
              />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={cancelAddJump} disabled={busy}>
                  Cancel
                </Button>
                <Button size="sm" onClick={createJumpHost} disabled={!isJumpHostDraftValid(jumpDraft) || busy}>
                  Create
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-1.5 text-[11px] leading-snug text-devdeck-dim">
              {dialog.jumpConnectionId
                ? 'The executor dials the jump host first, then tunnels the SSH handshake through it to reach this host.'
                : 'The executor dials this host directly.'}
            </p>
          )}
        </div>
      </div>

      {/* footer */}
      <div className="flex flex-none items-center justify-end gap-2.5 border-t border-devdeck-border px-[18px] py-3.5">
        <Button variant="secondary" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          {isEdit ? 'Save' : 'Add'}
        </Button>
      </div>
    </SideDrawer>
  )
}
