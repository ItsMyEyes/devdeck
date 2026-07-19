import { Copy, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseConnectionString } from '@/features/machines/connectionString'
import { useCreateMachine, useTailscaleStatus, useUpdateMachine } from '@/features/data/queries'
import type { TailscaleHubStatus } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'

/** 32 random bytes as 64 lowercase hex chars — mirrors the desktop sidecar's generate_key(). */
function generateRuntimeKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function runtimeCommand(key: string, hubUrl: string, name: string): string {
  return [
    `./devdeck.exe --role runtime --key ${key} --addr 0.0.0.0:9199 --db runtime.db --open=false \\`,
    `  --hub-url ${hubUrl} --hub-key <your-hub-key> --public-url http://<hostname>:9199 --name ${name.trim() || '<name>'}`,
  ].join('\n')
}

function tailscaleGuidance(reason: TailscaleHubStatus['reason']): {
  title: string
  body: string
  copyLabel?: string
  copyValue?: string
} {
  switch (reason) {
    case 'not_installed':
      return {
        title: "Tailscale isn't installed on this machine",
        body: 'Remote runtimes reach this hub over your tailnet. Install Tailscale here, then restart DevDeck.',
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

  const [runtimeKey, setRuntimeKey] = useState('')
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteText, setPasteText] = useState('')
  useEffect(() => {
    if (dialog.open && !isEdit) {
      setRuntimeKey(generateRuntimeKey())
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

  function copyCommand() {
    void navigator.clipboard.writeText(runtimeCommand(runtimeKey, resolvedHubUrl ?? window.location.origin, dialog.name))
    toast.success('Command copied')
  }

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
        Runtimes run worktrees, terminals, and git — reachable over your tailnet.
      </DialogDescription>

      {!isEdit ? (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setPasteMode((m) => !m)}
            className="cursor-pointer font-mono text-[11px] text-devdeck-muted-2 underline decoration-dotted hover:text-devdeck-accent-soft"
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
          <p className="mb-2 font-mono text-[10.5px] text-devdeck-dim-2">
            Paste the line from the runtime's <code>copy-this.md</code> (format: name|url|key).
          </p>
          <Input
            value={pasteText}
            disabled={busy}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="builder|https://builder.tail-x.ts.net|a1b2c3..."
            className="mb-1 font-mono"
          />
          <p className={`mb-5 font-mono text-[10.5px] ${pasteInvalid ? 'text-devdeck-red-soft' : 'text-devdeck-dim-2'}`}>
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
            <div className="mb-5 rounded-lg border border-devdeck-border-card bg-devdeck-terminal p-3">
              <p className="mb-1 font-mono text-[11px] text-devdeck-fg">{tailscaleNotReady.title}</p>
              <p className="mb-2 font-mono text-[10.5px] text-devdeck-dim-2">{tailscaleNotReady.body}</p>
              {tailscaleNotReady.copyValue ? (
                <button
                  type="button"
                  onClick={() => copyTailscaleLink(tailscaleNotReady.copyValue!)}
                  className="cursor-pointer font-mono text-[10.5px] text-devdeck-accent-soft underline decoration-dotted"
                >
                  {tailscaleNotReady.copyLabel}
                </button>
              ) : null}
            </div>
          ) : isLoopbackHub && tailscaleStatus.isLoading ? (
            <p className="mb-5 font-mono text-[10.5px] text-devdeck-dim-2">Checking Tailscale…</p>
          ) : (
            <>
              <Label>Runtime command</Label>
              <p className="mb-2 font-mono text-[10.5px] text-devdeck-dim-2">
                Run this on the target runtime — replace &lt;your-hub-key&gt; and &lt;hostname&gt;. It self-registers with
                this hub on startup.
              </p>
              <div className="relative mb-5 rounded-lg border border-devdeck-border-card bg-devdeck-terminal p-2.5 pr-9">
                <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-devdeck-fg">
                  {runtimeCommand(runtimeKey, resolvedHubUrl ?? window.location.origin, dialog.name)}
                </pre>
                <button
                  type="button"
                  onClick={copyCommand}
                  aria-label="Copy command"
                  className="absolute right-2.5 top-2.5 cursor-pointer p-1 text-devdeck-muted-2 hover:text-devdeck-accent-soft"
                >
                  <Copy size={12} />
                </button>
              </div>
            </>
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
        ) : tailscaleNotReady || (isLoopbackHub && tailscaleStatus.isLoading) ? null : (
          <Button onClick={copyCommand}>
            <Copy size={13} />
            Copy command
          </Button>
        )}
      </div>
    </Dialog>
  )
}
