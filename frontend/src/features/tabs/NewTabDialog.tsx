import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Check, Globe, Loader2, Network, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useCreateSSHConnection, useMachines, useMachinesHealth, useSSHConnections } from '@/features/data/queries'
import { SSHAuthFields } from '@/features/ssh/SSHAuthFields'
import { parseSSHCommand } from '@/features/ssh/sshCommand'
import {
  applyIdentityFile,
  buildSSHQuickAddPlan,
  defaultSSHQuickAddDraft,
  deriveSSHQuickAddName,
  findExistingConnection,
  isSSHQuickAddValid,
  type QuickAddPlan,
} from '@/features/ssh/sshQuickAdd'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { Project } from '@/store/types'

/** Sentinel for "create a host from an ssh command", mirroring
 *  SSHConnectionDialog's own `ADD_NEW_JUMP` option so "existing or new" stays
 *  one control instead of a separate mode switch. */
const NEW_SSH_HOST = '__new__'
/** Empty executor id — the hub picks which machine dials. */
const HUB_DECIDES = ''

interface NewTabDialogProps {
  wsId: string
  projects: Project[]
  currentProjectId?: string
  onCreateBrowser: (machineId: string) => void
  onCreateShell: (projectId: string) => void
  onCreateSSH: (connectionId: string) => void
}

/** The tab strip's "+" chooser: pick Browser, Spawn shell, or SSH. Browser and
 *  Spawn shell need a machine to run on, defaulted to the first registered one
 *  so Create isn't blocked on an empty selection. SSH instead picks a saved
 *  host — or creates one on the spot from a pasted `ssh user@host -J bastion`
 *  command. */
export function NewTabDialog({
  wsId,
  projects,
  currentProjectId,
  onCreateBrowser,
  onCreateShell,
  onCreateSSH,
}: NewTabDialogProps) {
  const newTab = useDevDeckStore((s) => s.newTab)
  const closeNewTab = useDevDeckStore((s) => s.closeNewTab)
  const setNewTab = useDevDeckStore((s) => s.setNewTab)
  const showToast = useDevDeckStore((s) => s.showToast)
  const machines = useMachines().data ?? []
  const machineHealth = useMachinesHealth(machines)
  const connectionsQuery = useSSHConnections()
  const connections = connectionsQuery.data ?? []
  const createConnection = useCreateSSHConnection()
  const [draft, setDraft] = useState(defaultSSHQuickAddDraft())
  const open = newTab.open && newTab.wsId === wsId

  useEffect(() => {
    if (open && !newTab.machineId && machines.length > 0) {
      setNewTab({ machineId: machines[0].id })
    }
  }, [open, newTab.machineId, machines, setNewTab])

  // Default the host picker once the connection list has actually loaded: the
  // first saved host, or the quick-add form when there are none. The
  // `isLoading` guard matters — `.data ?? []` is an empty array while the query
  // is still in flight, and committing `NEW_SSH_HOST` from that would stick:
  // the `newTab.sshConnectionId` truthiness guard stops this effect from ever
  // re-running once it has written something.
  useEffect(() => {
    if (!open || newTab.kind !== 'ssh' || newTab.sshConnectionId || connectionsQuery.isLoading) return
    setNewTab({ sshConnectionId: connections[0]?.id ?? NEW_SSH_HOST })
  }, [open, newTab.kind, newTab.sshConnectionId, connections, connectionsQuery.isLoading, setNewTab])

  // A fresh dialog starts with a fresh quick-add draft — credentials must not
  // survive a close/reopen.
  useEffect(() => {
    if (!open) setDraft(defaultSSHQuickAddDraft())
  }, [open])

  const parsed = useMemo(() => parseSSHCommand(draft.raw), [draft.raw])
  const busy = createConnection.isPending

  const machineOptions = machines.map((m) => ({
    value: m.id,
    label: m.name,
    disabled: machineHealth.get(m.id)?.status === 'offline',
  }))
  const executorOptions = [{ value: HUB_DECIDES, label: 'Hub decides' }, ...machineOptions]
  const hostOptions = [
    { value: NEW_SSH_HOST, label: '+ New host from ssh command…' },
    ...connections.map((c) => ({ value: c.id, label: c.name })),
  ]

  const shellProjects = projects.filter((p) => p.machineId === newTab.machineId)
  const shellProject = shellProjects.find((p) => p.id === currentProjectId) ?? shellProjects[0]
  const addingSSHHost = newTab.sshConnectionId === NEW_SSH_HOST
  // Only offer the "different credentials" toggle when a hop will actually be
  // created — an already-saved bastion brings its own.
  const createsHop = (parsed?.jumps ?? []).some((hop) => !findExistingConnection(hop, connections))

  // `busy` gates every branch, not just the SSH one: an in-flight create chain
  // must not be overtaken by a second Create in another kind.
  const canCreate =
    !busy &&
    (newTab.kind === 'ssh'
      ? addingSSHHost
        ? isSSHQuickAddValid(parsed, draft, connections)
        : Boolean(newTab.sshConnectionId)
      : !!newTab.machineId && (newTab.kind === 'browser' || !!shellProject))

  function handleRawChange(raw: string) {
    setDraft((d) => {
      const next = { ...d, raw }
      const parsedNext = parseSSHCommand(raw)
      if (!parsedNext) return next
      // Re-derive the name only while the user hasn't typed their own.
      const name = d.nameTouched ? d.name : deriveSSHQuickAddName(parsedNext)
      return applyIdentityFile({ ...next, name }, parsedNext)
    })
  }

  /** Runs the plan in order, threading each created row's id into the next
   *  step's `jumpConnectionId`. Returns the target connection's id. */
  async function runPlan(plan: QuickAddPlan): Promise<string> {
    let previousId: string | null = null
    for (const step of plan.steps) {
      if (step.kind === 'existing') {
        previousId = step.id
        continue
      }
      const created = await createConnection.mutateAsync({ ...step.body, jumpConnectionId: previousId })
      previousId = created.id
    }
    // buildSSHQuickAddPlan always ends with a `create` step for the target.
    return previousId as string
  }

  async function submit() {
    if (!canCreate) return

    if (newTab.kind === 'ssh') {
      if (!addingSSHHost) {
        closeNewTab()
        onCreateSSH(newTab.sshConnectionId)
        return
      }
      if (!parsed) return
      try {
        const connectionId = await runPlan(buildSSHQuickAddPlan(parsed, draft, connections))
        closeNewTab()
        showToast(`Added SSH connection "${draft.name.trim()}"`)
        onCreateSSH(connectionId)
      } catch (err) {
        // Hops created before the failure stay saved on purpose — a retry
        // reuse-matches them instead of duplicating them.
        showToast(err instanceof Error ? err.message : 'Failed to add SSH connection')
      }
      return
    }

    closeNewTab()
    if (newTab.kind === 'browser') onCreateBrowser(newTab.machineId)
    else if (shellProject) onCreateShell(shellProject.id)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && closeNewTab()} width={440}>
      <DialogTitle>New tab</DialogTitle>
      <DialogDescription className="mb-4">Choose what to open and where to run it.</DialogDescription>

      {/* Locked while a create chain is in flight — switching kind mid-chain
          would re-enable Create for a different kind and let a second tab open
          on top of the one the pending chain is about to produce. */}
      <div className="mb-4 flex gap-1.5 rounded-lg border border-devdeck-border-strong bg-devdeck-bg p-1">
        <KindTab active={newTab.kind === 'browser'} disabled={busy} onClick={() => setNewTab({ kind: 'browser' })}>
          <Globe size={13} />
          Browser
        </KindTab>
        <KindTab active={newTab.kind === 'shell'} disabled={busy} onClick={() => setNewTab({ kind: 'shell' })}>
          <TerminalSquare size={13} />
          Spawn shell
        </KindTab>
        <KindTab active={newTab.kind === 'ssh'} disabled={busy} onClick={() => setNewTab({ kind: 'ssh' })}>
          <Network size={13} />
          SSH
        </KindTab>
      </div>

      {newTab.kind === 'ssh' ? (
        <div className="mb-5">
          <Label>Host</Label>
          <Select
            value={newTab.sshConnectionId}
            onValueChange={(v) => setNewTab({ sshConnectionId: v })}
            options={hostOptions}
            disabled={busy}
            aria-label="Host"
          />

          {addingSSHHost ? (
            <div className="mt-3 rounded-[12px] border border-devdeck-border-card bg-devdeck-surface-2 p-3">
              <Label>ssh command</Label>
              <Input
                value={draft.raw}
                disabled={busy}
                onChange={(e) => handleRawChange(e.target.value)}
                placeholder="ssh root@10.1.1.1 -J root@bastion"
                className="mb-1.5 font-mono"
                aria-label="ssh command"
              />
              {parsed ? (
                <p className="mb-3 font-mono text-[11px] leading-snug text-devdeck-dim">
                  {parsed.target.user || '(no user)'}@{parsed.target.host}:{parsed.target.port}
                  {parsed.jumps.length > 0
                    ? ` · via ${parsed.jumps.map((hop) => `${hop.user}@${hop.host}`).join(' → ')}`
                    : ''}
                  {parsed.ignoredFlags.length > 0 ? ` · ignored: ${parsed.ignoredFlags.join(' ')}` : ''}
                </p>
              ) : draft.raw.trim() ? (
                <p className="mb-3 font-mono text-[11px] text-devdeck-red-soft">Can't read that ssh command.</p>
              ) : (
                <p className="mb-3 font-mono text-[11px] text-devdeck-dim">
                  Paste a full command — user, port, -i and -J are read from it.
                </p>
              )}
              {parsed && !parsed.target.user ? (
                <p className="mb-3 font-mono text-[11px] text-devdeck-red-soft">
                  No username in that command — add one as user@host or -l user.
                </p>
              ) : null}

              <Label>Name</Label>
              <Input
                value={draft.name}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value, nameTouched: true }))}
                placeholder="prod-web"
                className="mb-3 font-mono"
              />

              <Label>Executor machine</Label>
              <Select
                value={draft.executorMachineId}
                onValueChange={(v) => setDraft((d) => ({ ...d, executorMachineId: v }))}
                options={executorOptions}
                disabled={busy}
                aria-label="Executor machine"
                className="mb-3"
              />

              <SSHAuthFields
                authType={draft.auth.authType}
                password={draft.auth.password}
                privateKey={draft.auth.privateKey}
                privateKeyPath={draft.auth.privateKeyPath}
                passphrase={draft.auth.passphrase}
                onChange={(patch) => setDraft((d) => ({ ...d, auth: { ...d.auth, ...patch } }))}
                disabled={busy}
              />

              {createsHop ? (
                <>
                  <CheckboxRow
                    checked={draft.jumpAuthOverride}
                    disabled={busy}
                    onChange={(checked) => setDraft((d) => ({ ...d, jumpAuthOverride: checked }))}
                    label="Jump host uses different credentials"
                  />
                  {draft.jumpAuthOverride ? (
                    <div className="mt-2.5 rounded-lg border border-devdeck-border-strong bg-devdeck-bg p-2.5">
                      <SSHAuthFields
                        authType={draft.jumpAuth.authType}
                        password={draft.jumpAuth.password}
                        privateKey={draft.jumpAuth.privateKey}
                        privateKeyPath={draft.jumpAuth.privateKeyPath}
                        passphrase={draft.jumpAuth.passphrase}
                        onChange={(patch) => setDraft((d) => ({ ...d, jumpAuth: { ...d.jumpAuth, ...patch } }))}
                        disabled={busy}
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : connections.length === 0 ? (
            <p className="mt-1.5 font-mono text-[11px] text-devdeck-dim">No saved hosts yet.</p>
          ) : null}
        </div>
      ) : (
        <div className="mb-5">
          <Label>Machine</Label>
          {machines.length === 0 ? (
            <p className="mt-1 font-mono text-[11px] text-devdeck-dim">Add a machine first.</p>
          ) : (
            <Select
              value={newTab.machineId}
              onValueChange={(v) => setNewTab({ machineId: v })}
              options={machineOptions}
              aria-label="Machine"
            />
          )}
          {newTab.kind === 'shell' && newTab.machineId && !shellProject ? (
            <p className="mt-1.5 font-mono text-[11px] text-devdeck-red-soft">No project on this machine yet.</p>
          ) : null}
        </div>
      )}

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={closeNewTab} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={!canCreate}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          Create →
        </Button>
      </div>
    </Dialog>
  )
}

function KindTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-[30px] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[12px] font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        active ? 'bg-primary text-primary-foreground' : 'bg-transparent text-devdeck-muted hover:text-devdeck-fg',
      )}
    >
      {children}
    </button>
  )
}

/** There is no shared Checkbox in components/ui — this matches the inline
 *  checkbox button TodosModule already uses for its done toggle. */
function CheckboxRow({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="mt-1 flex cursor-pointer items-center gap-2 text-left disabled:opacity-50"
    >
      <span
        className={cn(
          'flex h-[15px] w-[15px] flex-none items-center justify-center rounded-[4px] border transition-colors',
          checked
            ? 'border-devdeck-accent bg-primary text-primary-foreground'
            : 'border-devdeck-border-strong text-transparent',
        )}
      >
        <Check size={10} strokeWidth={3} />
      </span>
      <span className="text-[11.5px] text-devdeck-fg-2">{label}</span>
    </button>
  )
}
