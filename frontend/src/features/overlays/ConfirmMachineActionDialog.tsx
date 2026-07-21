import { Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useRestartMachine, useStopMachine } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const COPY = {
  restart: {
    title: 'Restart runtime',
    body: (name: string) =>
      `This restarts the runtime process on "${name}". Active terminals on this machine will disconnect and reconnect once it's back — usually a few seconds.`,
    confirmLabel: 'Restart',
    iconClassName: 'text-devdeck-yellow-soft',
    confirmVariant: 'warning' as const,
  },
  stop: {
    title: 'Stop runtime',
    body: (name: string) =>
      `This stops the runtime process on "${name}". It will not come back on its own — you'll need to relaunch it manually on that machine.`,
    confirmLabel: 'Stop',
    iconClassName: 'text-devdeck-red-soft',
    confirmVariant: 'destructive-solid' as const,
  },
}

export function ConfirmMachineActionDialog() {
  const confirm = useDevDeckStore((s) => s.confirmMachineAction)
  const cancel = useDevDeckStore((s) => s.cancelMachineAction)
  const showToast = useDevDeckStore((s) => s.showToast)
  const restartMachine = useRestartMachine()
  const stopMachine = useStopMachine()

  const open = !!confirm
  const pending = restartMachine.isPending || stopMachine.isPending
  const copy = confirm ? COPY[confirm.action] : null

  function onConfirm() {
    if (!confirm) return
    const { action, id, name } = confirm
    const mutation = action === 'restart' ? restartMachine : stopMachine
    mutation.mutate(id, {
      onSuccess: () => {
        cancel()
        showToast(`${action === 'restart' ? 'Restarting' : 'Stopping'} "${name}"`)
      },
      onError: (err) => showToast(err instanceof Error ? err.message : `Failed to ${action} "${name}"`),
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && cancel()} width={400} z={70}>
      <div className="mb-2.5 flex items-center gap-2.5">
        <TriangleAlert size={15} className={copy?.iconClassName} />
        <DialogTitle>{copy?.title ?? ''}</DialogTitle>
      </div>
      <DialogDescription className="mb-5 font-sans text-[12.5px] leading-[1.55] text-devdeck-muted">
        {confirm && copy ? copy.body(confirm.name) : ''}
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
