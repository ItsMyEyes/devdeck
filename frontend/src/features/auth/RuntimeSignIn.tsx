import { useState } from 'react'
import type { FormEvent } from 'react'
import { toast } from 'sonner'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { request } from '@/lib/api'

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
 * - The static key field: always available, and the only path that works
 *   when the hub itself is unreachable.
 */
export function RuntimeSignIn({ machineName, hubUrl, machineId }: RuntimeSignInProps) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const canSSO = hubUrl !== '' && machineId !== ''

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!key.trim()) return
    setBusy(true)
    try {
      await request('POST', '/auth/key-session', undefined, {
        headers: { Authorization: `Bearer ${key.trim()}` },
      })
      window.location.reload()
    } catch {
      toast.error('That key was not accepted')
      setBusy(false)
    }
  }

  function signInViaHub() {
    const returnUrl = window.location.origin
    const url = `${hubUrl.replace(/\/+$/, '')}/handover?machine=${encodeURIComponent(machineId)}&return=${encodeURIComponent(returnUrl)}`
    window.location.href = url
  }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-devdeck-bg text-devdeck-fg">
      <div className="w-[360px]">
        <h1 className="text-lg font-medium">{machineName || 'Runtime'}</h1>
        <p className="mt-1 mb-6 text-[12px] text-devdeck-muted">Sign in to this runtime.</p>

        {canSSO && (
          <>
            <Button type="button" variant="secondary" className="mb-4 w-full" onClick={signInViaHub}>
              <ExternalLink className="h-3.5 w-3.5" />
              Sign in via hub
            </Button>
            <div className="mb-4 flex items-center gap-2 text-[11px] text-devdeck-dim">
              <div className="h-px flex-1 bg-devdeck-dim-3" />
              or
              <div className="h-px flex-1 bg-devdeck-dim-3" />
            </div>
          </>
        )}

        <form onSubmit={submit}>
          <Label>Runtime key</Label>
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Runtime key"
            autoFocus={!canSSO}
            className="mb-5"
          />
          <Button type="submit" disabled={busy || !key.trim()} className="w-full">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Sign in
          </Button>
        </form>
      </div>
    </div>
  )
}
