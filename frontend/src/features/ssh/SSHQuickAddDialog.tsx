import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
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

/** Empty executor id — the hub picks which machine dials. */
const HUB_DECIDES = ''

interface SSHQuickAddDialogProps {
  onCreateSSH: (connectionId: string) => void
}

/** Creates an SSH host from a pasted `ssh user@host -J bastion` command.
 *
 *  Narrowed from the old `NewTabDialog`, which also chose between Browser /
 *  Spawn shell / SSH and picked a machine and a saved host. The command
 *  palette owns all of that now — picking from a list is a palette drill-down,
 *  so this dialog is always in quick-add mode and only exists for the one
 *  thing a palette row cannot express: a multi-field form with credentials.
 *
 *  Reached from the palette's `Create › New SSH › New host from ssh command…`
 *  row, or from a typed `ssh …` command that needs credentials the palette
 *  cannot supply (a password, or an unresolvable identity file). */
export function SSHQuickAddDialog({ onCreateSSH }: SSHQuickAddDialogProps) {
  const sshQuickAdd = useDevDeckStore((s) => s.sshQuickAdd)
  const closeSSHQuickAdd = useDevDeckStore((s) => s.closeSSHQuickAdd)
  const showToast = useDevDeckStore((s) => s.showToast)
  const machines = useMachines().data ?? []
  const machineHealth = useMachinesHealth(machines)
  const connectionsQuery = useSSHConnections()
  const connections = connectionsQuery.data ?? []
  const createConnection = useCreateSSHConnection()
  const [draft, setDraft] = useState(defaultSSHQuickAddDraft())
  const rawInputRef = useRef<HTMLInputElement>(null)
  const open = sshQuickAdd.open
  const wsId = sshQuickAdd.wsId
  const prefillRaw = sshQuickAdd.prefillRaw

  // A fresh dialog starts from `prefillRaw` — seeded through `handleRawChange`
  // rather than assigned directly, so the name and identity file derive exactly
  // as if the user had typed the command themselves. Closing resets to a blank
  // draft: credentials must not survive a close/reopen.
  useEffect(() => {
    if (!open) {
      setDraft(defaultSSHQuickAddDraft())
      return
    }
    setDraft(seedDraft(prefillRaw))
    // Keyboard-only path: the palette hands off mid-flow, so the field the
    // user was already typing into must take focus without a click.
    requestAnimationFrame(() => rawInputRef.current?.focus())
  }, [open, prefillRaw])

  const parsed = useMemo(() => parseSSHCommand(draft.raw), [draft.raw])
  const busy = createConnection.isPending

  const executorOptions = [
    { value: HUB_DECIDES, label: 'Hub decides' },
    ...machines.map((m) => ({
      value: m.id,
      label: m.name,
      disabled: machineHealth.get(m.id)?.status === 'offline',
    })),
  ]

  // Only offer the "different credentials" toggle when a hop will actually be
  // created — an already-saved bastion brings its own.
  const createsHop = (parsed?.jumps ?? []).some((hop) => !findExistingConnection(hop, connections))

  const canCreate = !busy && isSSHQuickAddValid(parsed, draft, connections)

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
    if (!canCreate || !parsed) return

    // The create chain below has a real `await` before it touches
    // `onCreateSSH`/`closeSSHQuickAdd`. If the user navigates to a different
    // workspace while it's in flight, `wsId` keeps pointing at the workspace
    // open when Create was clicked (WorkspaceTileArea is never remounted on a
    // route change), so blindly firing `onCreateSSH` after the await would
    // yank the user back to that stale workspace and `closeSSHQuickAdd()`
    // would dismiss whatever dialog they've since opened elsewhere. Re-check
    // the *current* store state right before doing either — the connection
    // itself stays saved regardless.
    const submittedWsId = wsId
    try {
      const connectionId = await runPlan(buildSSHQuickAddPlan(parsed, draft, connections))
      showToast(`Added SSH connection "${draft.name.trim()}"`)
      if (useDevDeckStore.getState().sshQuickAdd.wsId === submittedWsId) {
        closeSSHQuickAdd()
        onCreateSSH(connectionId)
      }
    } catch (err) {
      // Hops created before the failure stay saved on purpose — a retry
      // reuse-matches them instead of duplicating them.
      showToast(err instanceof Error ? err.message : 'Failed to add SSH connection')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && closeSSHQuickAdd()} width={440}>
      <DialogTitle>New SSH host</DialogTitle>
      <DialogDescription className="mb-4">
        Paste a full ssh command - user, port, -i and -J are read from it.
      </DialogDescription>

      {/* Enter submits from any field so the whole flow stays keyboard-only;
          textarea-free by design, and Create is already gated by `canCreate`. */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="mb-5">
          <div className="rounded-control border border-devdeck-border-card bg-devdeck-card-wash p-3">
            <Label>ssh command</Label>
            <Input
              ref={rawInputRef}
              value={draft.raw}
              disabled={busy}
              onChange={(e) => handleRawChange(e.target.value)}
              placeholder="ssh root@10.1.1.1 -J root@bastion"
              className="mb-1.5 font-mono"
              aria-label="ssh command"
            />
              {parsed ? (
                <p className="mb-3 font-mono text-[11px] leading-snug text-devdeck-fg-2">
                  {parsed.target.user || '(no user)'}@{parsed.target.host}:{parsed.target.port}
                  {parsed.jumps.length > 0
                    ? ` · via ${parsed.jumps.map((hop) => `${hop.user}@${hop.host}`).join(' → ')}`
                    : ''}
                  {parsed.ignoredFlags.length > 0 ? ` · ignored: ${parsed.ignoredFlags.join(' ')}` : ''}
                </p>
              ) : draft.raw.trim() ? (
                <p className="mb-3 font-mono text-[11px] text-devdeck-err">Can't read that ssh command.</p>
              ) : (
                <p className="mb-3 font-mono text-[11px] text-devdeck-fg-2">
                  Paste a full command - user, port, -i and -J are read from it.
                </p>
              )}
              {parsed && !parsed.target.user ? (
                <p className="mb-3 font-mono text-[11px] text-devdeck-err">
                  No username in that command - add one as user@host or -l user.
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
                    <div className="mt-2.5 rounded-lg border border-devdeck-border-strong bg-devdeck-pane p-2.5">
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
        </div>

        <div className="flex justify-end gap-2.5">
          <Button type="button" variant="secondary" onClick={closeSSHQuickAdd} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canCreate}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            Create →
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** Builds the initial draft from a raw ssh command, deriving the name and
 *  identity file exactly as `handleRawChange` does for typed input — so a
 *  command handed over by the palette lands in the same state it would have
 *  reached had the user typed it here. */
function seedDraft(raw: string) {
  const base = defaultSSHQuickAddDraft()
  if (!raw) return base
  const parsed = parseSSHCommand(raw)
  if (!parsed) return { ...base, raw }
  return applyIdentityFile({ ...base, raw, name: deriveSSHQuickAddName(parsed) }, parsed)
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
          'flex h-[15px] w-[15px] flex-none items-center justify-center rounded-micro border transition-colors',
          checked
            ? 'border-devdeck-line bg-devdeck-on text-devdeck-fg'
            : 'border-devdeck-border-strong text-transparent',
        )}
      >
        <Check size={10} strokeWidth={3} />
      </span>
      <span className="text-[11.5px] text-devdeck-fg-2">{label}</span>
    </button>
  )
}
