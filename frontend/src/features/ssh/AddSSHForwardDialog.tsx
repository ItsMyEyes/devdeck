import { useEffect, useState } from 'react'
import { TriangleAlert, Waypoints } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { SSHForward, SSHForwardMode } from '@/store/types'

export interface ForwardFormBody {
  mode: SSHForwardMode
  bindHost: string
  bindPort: number
  targetHost: string
  targetPort: number
  label: string
}

const MODE_OPTIONS: { value: SSHForwardMode; label: string; blurb: string }[] = [
  {
    value: 'local',
    label: 'Local · -L',
    blurb: 'The hub listens on Bind and forwards each connection to Target through this SSH session.',
  },
  {
    value: 'remote',
    label: 'Remote · -R',
    blurb: 'The remote host listens on Bind (needs `GatewayPorts yes` there) and forwards connections back to Target on this side.',
  },
  {
    value: 'dynamic',
    label: 'Dynamic · -D',
    blurb: 'The hub exposes a SOCKS5 proxy on Bind — traffic routes through this SSH session to wherever the client asks.',
  },
]

/** Add/edit a forwarding rule. A modal rather than an always-open inline form
 *  (matching AddMCPDialog's pattern) so the narrow sidebar's default view is
 *  just the rule list, and the mode-specific fields (Target is meaningless
 *  for 'dynamic') only take up room while actually being filled in. */
export function AddSSHForwardDialog({
  open,
  editing,
  pending,
  restartsRunning,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  editing: SSHForward | null
  pending: boolean
  /** True when `editing` is currently running/reconnecting — saving stops and
   *  restarts its live listener, so anything connected through it drops. */
  restartsRunning?: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (body: ForwardFormBody) => void
}) {
  const [mode, setMode] = useState<SSHForwardMode>('local')
  const [bindHost, setBindHost] = useState('127.0.0.1')
  const [bindPort, setBindPort] = useState('')
  const [targetHost, setTargetHost] = useState('')
  const [targetPort, setTargetPort] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setMode(editing?.mode ?? 'local')
    setBindHost(editing?.bindHost ?? '127.0.0.1')
    setBindPort(editing ? String(editing.bindPort) : '')
    setTargetHost(editing?.targetHost ?? '')
    setTargetPort(editing && editing.targetPort !== 0 ? String(editing.targetPort) : '')
    setLabel(editing?.label ?? '')
    setError('')
  }, [open, editing])

  const activeMode = MODE_OPTIONS.find((item) => item.value === mode) ?? MODE_OPTIONS[0]

  function submit() {
    const port = Number(bindPort)
    if (!bindPort || !Number.isInteger(port) || port < 1 || port > 65535) {
      setError('Bind port must be between 1 and 65535.')
      return
    }
    if (mode !== 'dynamic') {
      if (!targetHost.trim()) {
        setError('Target host is required.')
        return
      }
      const tPort = Number(targetPort)
      if (!targetPort || !Number.isInteger(tPort) || tPort < 1 || tPort > 65535) {
        setError('Target port must be between 1 and 65535.')
        return
      }
    }
    setError('')
    onSubmit({
      mode,
      bindHost: bindHost.trim() || '127.0.0.1',
      bindPort: port,
      targetHost: mode === 'dynamic' ? '' : targetHost.trim(),
      targetPort: mode === 'dynamic' ? 0 : Number(targetPort),
      label: label.trim(),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={440}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-devdeck-line bg-devdeck-on text-devdeck-fg-2">
          <Waypoints size={17} />
        </div>
        <div>
          <DialogTitle>{editing ? 'Edit forwarding rule' : 'Add forwarding rule'}</DialogTitle>
          <DialogDescription className="mt-1.5 leading-relaxed">{activeMode.blurb}</DialogDescription>
        </div>
      </div>

      <div className="mt-5 grid gap-4">
        {restartsRunning ? (
          <div className="flex items-start gap-2 rounded-lg border border-devdeck-yellow-tint-border bg-devdeck-yellow-tint px-3 py-2.5 text-[10.5px] leading-relaxed text-devdeck-yellow-tint-text">
            <TriangleAlert size={14} className="mt-0.5 flex-none" />
            This forward is running — saving restarts it, dropping any active connections through it.
          </div>
        ) : null}

        <fieldset>
          <legend className="mb-2 text-[11.5px] font-medium text-devdeck-fg-2">Mode</legend>
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-devdeck-border-card bg-devdeck-card-wash p-1">
            {MODE_OPTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setMode(item.value)}
                className={cn(
                  'min-h-9 cursor-pointer rounded-md px-2 py-1.5 font-mono text-[10.5px] leading-tight transition-colors',
                  mode === item.value
                    ? 'bg-devdeck-glass-solid text-devdeck-fg shadow-[inset_0_0_0_1px_var(--devdeck-border-strong)]'
                    : 'text-devdeck-fg-2 hover:text-devdeck-fg-2',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="grid gap-1.5">
          <span className="text-[11.5px] font-medium text-devdeck-fg-2">Label (optional)</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Postgres" autoComplete="off" />
        </label>

        <fieldset>
          <legend className="mb-2 text-[11.5px] font-medium text-devdeck-fg-2">Bind — where this listens</legend>
          <div className="flex gap-2">
            <Input
              value={bindHost}
              onChange={(e) => setBindHost(e.target.value)}
              placeholder="127.0.0.1"
              aria-label="Bind host"
              className="min-w-0 flex-1 font-mono"
            />
            <Input
              value={bindPort}
              onChange={(e) => setBindPort(e.target.value)}
              placeholder="Port"
              inputMode="numeric"
              aria-label="Bind port"
              className="w-24 flex-none font-mono"
            />
          </div>
        </fieldset>

        {mode !== 'dynamic' ? (
          <fieldset>
            <legend className="mb-2 text-[11.5px] font-medium text-devdeck-fg-2">
              Target — {mode === 'remote' ? 'reached from this side' : 'reached through the SSH session'}
            </legend>
            <div className="flex gap-2">
              <Input
                value={targetHost}
                onChange={(e) => setTargetHost(e.target.value)}
                placeholder="Target host"
                aria-label="Target host"
                className="min-w-0 flex-1 font-mono"
              />
              <Input
                value={targetPort}
                onChange={(e) => setTargetPort(e.target.value)}
                placeholder="Port"
                inputMode="numeric"
                aria-label="Target port"
                className="w-24 flex-none font-mono"
              />
            </div>
          </fieldset>
        ) : null}

        {error ? (
          <div role="alert" className="rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint-hover px-3 py-2 text-[11px] text-devdeck-err">
            {error}
          </div>
        ) : null}
      </div>

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <DialogClose render={<Button variant="secondary" className="w-full sm:w-auto" disabled={pending} />}>
          Cancel
        </DialogClose>
        <Button className="w-full sm:w-auto" disabled={pending} onClick={submit}>
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Add rule'}
        </Button>
      </div>
    </Dialog>
  )
}
