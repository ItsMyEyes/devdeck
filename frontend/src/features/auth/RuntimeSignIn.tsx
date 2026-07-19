import { useState } from 'react'
import type { FormEvent } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { request } from '@/lib/api'

/**
 * Sign-in for a runtime's own web UI. A runtime has no password/TOTP flow —
 * possession of its static --key is the entire authorization, exchanged here
 * for a session cookie. This is the path that still works when the hub is
 * down.
 *
 * The spec's second option — a "Sign in via hub" button granting SSO with
 * inherited 2FA — needs the Ed25519 handover token that Phase 4 delivers, so
 * it is deliberately absent here rather than shipped as a dead control.
 */
export function RuntimeSignIn({ machineName }: { machineName: string }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)

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

  return (
    <div className="flex h-screen w-full items-center justify-center bg-devdeck-bg text-devdeck-fg">
      <form onSubmit={submit} className="w-[360px]">
        <h1 className="text-lg font-medium">{machineName || 'Runtime'}</h1>
        <p className="mt-1 mb-6 text-[12px] text-devdeck-muted">
          Paste this runtime&rsquo;s key to sign in.
        </p>
        <Label>Runtime key</Label>
        <Input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Runtime key"
          autoFocus
          className="mb-5"
        />
        <Button type="submit" disabled={busy || !key.trim()} className="w-full">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Sign in
        </Button>
      </form>
    </div>
  )
}
