import { Loader2, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { PIN_LENGTH, PinInput } from '@/components/ui/pin-input'
import { isWeakPin } from '@/components/ui/pinEdit'
import { useMachines, useRuntimePinStatus, useUpdateRuntimePin } from '@/features/data/queries'
import { ApiError } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'

/**
 * Sets or rotates a runtime's 6-digit sign-in PIN — the credential its own web
 * UI asks for at /runtime-sign-in.
 *
 * Opened two ways, and the difference is only which process is targeted:
 * from the hub's Runtimes page (machineId set — the hub authenticates with
 * that runtime's key), or from a runtime's own settings (machineId null —
 * the current session cookie is the credential).
 *
 * Asks for the PIN twice because it can never be read back: only a bcrypt
 * hash is stored, so a typo here is discovered at the next sign-in, on the
 * machine you may no longer be sitting at.
 */
export function RuntimePinDialog() {
  const dialog = useDevDeckStore((s) => s.runtimePinDialog)
  const close = useDevDeckStore((s) => s.closeRuntimePin)
  const showToast = useDevDeckStore((s) => s.showToast)
  // Only the hub has a machine registry; a runtime rotating its own PIN
  // (machineId null) must not fire that request at all.
  const machines = useMachines(dialog.open && dialog.machineId !== null)

  const machine = dialog.machineId ? (machines.data?.find((m) => m.id === dialog.machineId) ?? null) : null
  // Waiting on useMachines to resolve the id is not the same as "this
  // process": hold the request rather than silently retargeting the hub.
  const unresolved = dialog.machineId !== null && machine === null

  const status = useRuntimePinStatus(machine, dialog.open && !unresolved)
  const update = useUpdateRuntimePin(machine)

  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (dialog.open) {
      setPin('')
      setConfirm('')
      setError(null)
    }
  }, [dialog.open])

  const complete = pin.length === PIN_LENGTH && confirm.length === PIN_LENGTH
  const mismatch = complete && pin !== confirm
  const weak = isWeakPin(pin)
  const busy = update.isPending
  const canSubmit = complete && !mismatch && !weak && !busy && !unresolved

  function submit() {
    if (!canSubmit) return
    setError(null)
    update.mutate(pin, {
      onSuccess: () => {
        close()
        showToast(`Sign-in PIN updated for "${dialog.machineName}"`)
      },
      onError: (err) => {
        setPin('')
        setConfirm('')
        setError(err instanceof ApiError ? err.message : 'Failed to update the PIN')
      },
    })
  }

  const hint = weak
    ? 'Pick something less guessable - no repeated digits or straight runs.'
    : mismatch
      ? 'The two PINs do not match.'
      : (error ?? null)

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={420}>
      <DialogTitle>Sign-in PIN</DialogTitle>
      <DialogDescription className="mb-[18px]">
        The {PIN_LENGTH}-digit code for {dialog.machineName || 'this runtime'}&apos;s own web UI. Its runtime key is
        unchanged - that stays the machine-to-machine credential.
      </DialogDescription>

      {unresolved ? (
        <p className="mb-5 font-mono text-[11px] text-devdeck-fg-2">Loading runtime…</p>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-2 font-mono text-[10.5px] text-devdeck-fg-2">
            <ShieldCheck size={12} className="flex-none" />
            {status.isLoading
              ? 'Checking current PIN…'
              : status.isError
                ? // Surfaced verbatim so the two very different failures read
                  // differently: an unreachable runtime, versus a target that
                  // has no sign-in PIN at all (a hub, or --role both).
                  (status.error instanceof ApiError ? status.error.message : 'This runtime is unreachable.')
                : status.data?.configured
                  ? 'A PIN is already set. Entering a new one replaces it immediately.'
                  : 'No PIN is set yet.'}
          </div>

          <div className="mb-1.5 text-[11px] text-devdeck-fg-2">New PIN</div>
          <PinInput
            label="New sign-in PIN"
            value={pin}
            onChange={(v) => {
              setPin(v)
              setError(null)
            }}
            disabled={busy}
            invalid={weak}
            autoFocus
            className="mb-3.5"
          />

          <div className="mb-1.5 text-[11px] text-devdeck-fg-2">Confirm PIN</div>
          <PinInput
            label="Confirm sign-in PIN"
            value={confirm}
            onChange={(v) => {
              setConfirm(v)
              setError(null)
            }}
            disabled={busy}
            invalid={mismatch}
          />

          <p
            className={`mt-2 mb-4 min-h-[16px] text-[11px] ${hint ? 'text-devdeck-err' : 'text-devdeck-fg-2'}`}
            role={hint ? 'alert' : undefined}
          >
            {hint ?? 'Anyone with this PIN can sign in to this runtime.'}
          </p>
        </>
      )}

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          Save PIN
        </Button>
      </div>
    </Dialog>
  )
}
