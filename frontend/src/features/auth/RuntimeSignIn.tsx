import { useState } from 'react'
import type { FormEvent } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PIN_LENGTH, PinInput } from '@/components/ui/pin-input'
import { ApiError, postPinSession } from '@/lib/api'

interface RuntimeSignInProps {
  machineName: string
  /** From useWhoami(); empty when this runtime has no --hub-url configured, or hasn't self-registered yet. */
  hubUrl: string
  machineId: string
}

/**
 * Sign-in for a runtime's own web UI. Two independent paths:
 *
 * - "Sign in via hub": a full top-level navigation to the hub's /handover
 *   route, which mints a short-lived token there and sends the browser
 *   back with ?t=<token> for RequireRuntimeAuth to verify. Only offered
 *   when hubUrl and machineId are both known (see Whoami) — if this
 *   runtime never registered with a hub, or hasn't yet, there is nothing
 *   to hand off to.
 * - The 6-digit PIN: always available, and the only path that works when the
 *   hub itself is unreachable. It replaced a pasted runtime key here — the
 *   key is still the machine-to-machine credential, but it is 64 hex
 *   characters and this page is often opened on a phone. A credential this
 *   short is only safe because the server locks a client out after a handful
 *   of wrong guesses (service.PINService.Verify); the 429 handled below is
 *   that lockout talking, and its message carries the remaining wait.
 */
export function RuntimeSignIn({ machineName, hubUrl, machineId }: RuntimeSignInProps) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canSSO = hubUrl !== '' && machineId !== ''

  function changePin(next: string) {
    setPin(next)
    setError(null)
  }

  // `override` carries the completed value straight from PinInput.onComplete,
  // which fires in the same tick the last digit lands — `pin` is still a
  // render behind at that point.
  async function submit(e?: FormEvent, override?: string) {
    e?.preventDefault()
    const value = override ?? pin
    if (value.length !== PIN_LENGTH || busy) return
    setBusy(true)
    setError(null)
    try {
      await postPinSession(value)
      window.location.reload()
    } catch (err) {
      setPin('')
      setError(err instanceof ApiError && err.status === 429 ? err.message : 'That PIN was not accepted')
      setBusy(false)
    }
  }

  function signInViaHub() {
    const returnUrl = window.location.origin
    const url = `${hubUrl.replace(/\/+$/, '')}/handover?machine=${encodeURIComponent(machineId)}&return=${encodeURIComponent(returnUrl)}`
    window.location.href = url
  }

  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center bg-devdeck-pane px-4 text-devdeck-fg">
      <div className="w-full max-w-[360px]">
        <h1 className="text-lg font-medium">{machineName || 'Runtime'}</h1>
        <p className="mt-1 mb-6 text-[12px] text-devdeck-fg-2">Sign in to this runtime.</p>

        {canSSO && (
          <>
            <Button type="button" variant="secondary" className="mb-4 w-full" onClick={signInViaHub}>
              <ExternalLink className="h-3.5 w-3.5" />
              Sign in via hub
            </Button>
            <div className="mb-4 flex items-center gap-2 text-[11px] text-devdeck-fg-2">
              <div className="h-px flex-1 bg-devdeck-fg-2" />
              or
              <div className="h-px flex-1 bg-devdeck-fg-2" />
            </div>
          </>
        )}

        <form onSubmit={submit}>
          <div className="mb-2 text-[11px] text-devdeck-fg-2">
            Enter this runtime&apos;s {PIN_LENGTH}-digit PIN
          </div>
          <PinInput
            label="Sign-in PIN"
            value={pin}
            onChange={changePin}
            onComplete={(value) => void submit(undefined, value)}
            disabled={busy}
            invalid={error !== null}
            autoFocus={!canSSO}
          />
          <p
            className={`mt-2 mb-4 min-h-[16px] text-[11px] ${error ? 'text-devdeck-err' : 'text-devdeck-fg-2'}`}
            role={error ? 'alert' : undefined}
          >
            {error ?? 'Set it from the hub’s Runtimes page - or find it in this runtime’s startup log.'}
          </p>
          <Button type="submit" disabled={busy || pin.length !== PIN_LENGTH} className="w-full">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Sign in
          </Button>
        </form>
      </div>
    </div>
  )
}
