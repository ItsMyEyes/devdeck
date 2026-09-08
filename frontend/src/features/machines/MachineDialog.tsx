import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseConnectionString } from '@/features/machines/connectionString'
import { useCreateMachine, useTailscaleStatus, useUpdateMachine } from '@/features/data/queries'
import { RuntimeInstallCommand } from '@/features/machines/RuntimeInstallCommand'
import type { TailscaleHubStatus } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'

function tailscaleGuidance(reason: TailscaleHubStatus['reason']): {
  title: string
  body: string
  copyLabel?: string
  copyValue?: string
} {
  switch (reason) {
    case 'not_installed':
      return {
        title: "Tailscale's CLI isn't reachable from this machine",
        body: "Remote runtimes reach this hub over your tailnet. Install Tailscale here — or, if the app is already installed, run its \"Install Tailscale command line tool\" menu action, since DevDeck shells out to the CLI. You can also skip Tailscale entirely and expose the hub on your local network from Settings › Network.",
        copyLabel: 'Copy Tailscale download link',
        copyValue: 'https://tailscale.com/download',
      }
    case 'not_ready':
      return {
        title: "Tailscale isn't signed in",
        body: "Open Tailscale (or run `tailscale up` in a terminal) and sign in with the same account you'll use on your runtime machines.",
      }
    case 'serve_disabled':
    default:
      return {
        title: 'Restart DevDeck to expose this hub',
        body: 'Tailscale looks ready, but this hub was started before it was set up. Restart DevDeck to pick it up.',
      }
  }
}

export function MachineDialog() {
  const dialog = useDevDeckStore((s) => s.machineDialog)
  const setDialog = useDevDeckStore((s) => s.setMachineDialog)
  const close = useDevDeckStore((s) => s.closeMachineDialog)
  const showToast = useDevDeckStore((s) => s.showToast)
  const updateMachine = useUpdateMachine()
  const createMachine = useCreateMachine()

  const isEdit = dialog.editingId !== null
  const busy = updateMachine.isPending || createMachine.isPending
  const canSubmit = dialog.name.trim().length > 0 && dialog.url.trim().length > 0 && dialog.key.trim().length > 0 && !busy

  const [pasteMode, setPasteMode] = useState(false)
  const [pasteText, setPasteText] = useState('')
  useEffect(() => {
    if (dialog.open && !isEdit) {
      setPasteMode(false)
      setPasteText('')
    }
  }, [dialog.open, isEdit])

  const isLoopbackHub = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
  const wantsTailscaleStatus = dialog.open && !isEdit && !pasteMode && isLoopbackHub
  const tailscaleStatus = useTailscaleStatus(wantsTailscaleStatus)
  const resolvedHubUrl = isLoopbackHub ? tailscaleStatus.data?.url : window.location.origin
  const tailscaleNotReady =
    isLoopbackHub && tailscaleStatus.data && !tailscaleStatus.data.ready
      ? tailscaleGuidance(tailscaleStatus.data.reason)
      : null

  const parsedPaste = pasteText.trim().length > 0 ? parseConnectionString(pasteText) : null
  const pasteInvalid = pasteText.trim().length > 0 && parsedPaste === null

  function copyTailscaleLink(value: string) {
    void navigator.clipboard.writeText(value)
    toast.success('Link copied')
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

  function submitPaste() {
    if (!parsedPaste || busy) return
    createMachine.mutate(parsedPaste, {
      onSuccess: () => {
        close()
        showToast(`Connected machine "${parsedPaste.name}"`)
      },
      onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to connect machine'),
    })
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={480}>
      <DialogTitle>{isEdit ? 'Edit runtime' : 'Add runtime'}</DialogTitle>
      <DialogDescription className="mb-[18px]">
        Runtimes run worktrees, terminals, and git - reachable over your tailnet.
      </DialogDescription>

      {!isEdit ? (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setPasteMode((m) => !m)}
            className="cursor-pointer font-mono text-[11px] text-devdeck-fg-2 underline decoration-dotted hover:text-devdeck-accent"
          >
            {pasteMode ? 'Use the self-register command instead' : 'Have a connection string instead?'}
          </button>
        </div>
      ) : null}

      {isEdit ? (
        <>
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
        </>
      ) : pasteMode ? (
        <>
          <Label>Connection string</Label>
          <p className="mb-2 font-mono text-[10.5px] text-devdeck-fg-2">
            Paste the line from the runtime's <code>copy-this.md</code> (format: name|url|key).
          </p>
          <Input
            value={pasteText}
            disabled={busy}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="builder|https://builder.tail-x.ts.net|a1b2c3..."
            className="mb-1 font-mono"
          />
          <p className={`mb-5 font-mono text-[10.5px] ${pasteInvalid ? 'text-devdeck-err' : 'text-devdeck-fg-2'}`}>
            {pasteInvalid
              ? 'Expected exactly 3 fields separated by "|": name, an https:// URL, and a key.'
              : parsedPaste
                ? `Will connect "${parsedPaste.name}" at ${parsedPaste.url}`
                : ' '}
          </p>
        </>
      ) : (
        <>
          <Label>Name</Label>
          <Input
            value={dialog.name}
            disabled={busy}
            onChange={(e) => setDialog({ name: e.target.value })}
            placeholder="builder"
            className="mb-3 font-mono"
          />

          {tailscaleNotReady ? (
            <div className="mb-5 rounded-lg border border-devdeck-border-card bg-devdeck-pane p-3">
              <p className="mb-1 font-mono text-[11px] text-devdeck-fg">{tailscaleNotReady.title}</p>
              <p className="mb-2 font-mono text-[10.5px] text-devdeck-fg-2">{tailscaleNotReady.body}</p>
              {tailscaleNotReady.copyValue ? (
                <button
                  type="button"
                  onClick={() => copyTailscaleLink(tailscaleNotReady.copyValue!)}
                  className="cursor-pointer font-mono text-[10.5px] text-devdeck-accent underline decoration-dotted"
                >
                  {tailscaleNotReady.copyLabel}
                </button>
              ) : null}
            </div>
          ) : isLoopbackHub && tailscaleStatus.isLoading ? (
            <p className="mb-5 font-mono text-[10.5px] text-devdeck-fg-2">Checking Tailscale…</p>
          ) : (
            <RuntimeInstallCommand hubUrl={resolvedHubUrl ?? window.location.origin} machineName={dialog.name} />
          )}
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
        ) : pasteMode ? (
          <Button onClick={submitPaste} disabled={!parsedPaste || busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            Connect
          </Button>
        ) : null}
      </div>
    </Dialog>
  )
}
