import { Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useInstallMachineUpdate, useRestartMachine, useStopMachine } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const COPY = {
  restart: {
    title: 'Restart runtime',
    body: (name: string) =>
      `This restarts the runtime process on "${name}". Active terminals on this machine will disconnect and reconnect once it's back - usually a few seconds.`,
    confirmLabel: 'Restart',
    iconClassName: 'text-devdeck-wait',
    confirmVariant: 'warning' as const,
  },
  stop: {
    title: 'Stop runtime',
    body: (name: string) =>
      `This stops the runtime process on "${name}". It will not come back on its own - you'll need to relaunch it manually on that machine.`,
    confirmLabel: 'Stop',
    iconClassName: 'text-devdeck-err',
    confirmVariant: 'destructive-solid' as const,
  },
  update: {
    title: 'Update runtime',
    body: (name: string) => `This updates the runtime on "${name}".`,
    confirmLabel: 'Update & restart',
    iconClassName: 'text-devdeck-wait',
    confirmVariant: 'warning' as const,
  },
}

export function ConfirmMachineActionDialog() {
  const confirm = useDevDeckStore((s) => s.confirmMachineAction)
  const cancel = useDevDeckStore((s) => s.cancelMachineAction)
  const showToast = useDevDeckStore((s) => s.showToast)
  const restartMachine = useRestartMachine()
  const stopMachine = useStopMachine()
  const installUpdate = useInstallMachineUpdate()

  const open = !!confirm
  const pending = restartMachine.isPending || stopMachine.isPending || installUpdate.isPending
  const copy = confirm ? COPY[confirm.action] : null

  function onConfirm() {
    if (!confirm) return
    const { action, id, name } = confirm

    if (action === 'update') {
      installUpdate.mutate(id, {
        onSuccess: (res) => {
          if (res.warning) showToast(res.warning)
          if (res.status === 'up-to-date') {
            cancel()
            showToast(`"${name}" is already on ${res.version}`)
            return
          }
          // Restart separately: a failed install must never restart, and a
          // failed restart still leaves the new binary staged for the next one.
          restartMachine.mutate(id, {
            onSuccess: () => {
              cancel()
              showToast(`Updated "${name}" to ${res.version} - restarting`)
            },
            onError: () => {
              cancel()
              showToast(`Updated "${name}" to ${res.version} - restart it to apply`)
            },
          })
        },
        onError: (err) => showToast(err instanceof Error ? err.message : `Failed to update "${name}"`),
      })
      return
    }

    const mutation = action === 'restart' ? restartMachine : stopMachine
    mutation.mutate(id, {
      onSuccess: () => {
        cancel()
        showToast(`${action === 'restart' ? 'Restarting' : 'Stopping'} "${name}"`)
      },
      onError: (err) => showToast(err instanceof Error ? err.message : `Failed to ${action} "${name}"`),
    })
  }

  const sessions = confirm?.activeSessions ?? 0
  const description =
    confirm?.action === 'update'
      ? `Updating "${confirm.name}"${confirm.version ? ` to ${confirm.version}` : ''} restarts its runtime process.` +
        (sessions > 0
          ? ` ${sessions} active terminal${sessions === 1 ? '' : 's'} on this machine will disconnect and reconnect once it's back.`
          : '')
      : confirm && copy
        ? copy.body(confirm.name)
        : ''

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && cancel()} width={400} z={70}>
      <div className="mb-2.5 flex items-center gap-2.5">
        <TriangleAlert size={15} className={copy?.iconClassName} />
        <DialogTitle>{copy?.title ?? ''}</DialogTitle>
      </div>
      <DialogDescription className="mb-5 font-sans text-[12.5px] leading-[1.55] text-devdeck-fg-2">
        {description}
      </DialogDescription>
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={cancel} disabled={pending}>
          Cancel
        </Button>
        <Button variant={copy?.confirmVariant ?? 'default'} onClick={onConfirm} disabled={pending}>
          {pending && <Loader2 size={14} className="animate-spin" />}
          {copy?.confirmLabel ?? ''}
        </Button>
      </div>
    </Dialog>
  )
}
