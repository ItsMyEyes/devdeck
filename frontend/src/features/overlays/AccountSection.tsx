import { Loader2, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useMe, useUpdateAccount } from '@/features/data/authQueries'
import type { UpdateAccountBody } from '@/lib/api'

/** Mirrors service.validatePassword on the hub, so a rejection that the server
 *  would issue anyway is shown before the round trip. */
const MIN_PASSWORD_LENGTH = 12

/**
 * Editor for the operator's own sign-in email and password.
 *
 * The desktop shell signs itself in with the hub key, so on a locally hosted
 * hub the account it created is a placeholder — `operator@devdeck.desktop`
 * with a random password nobody was ever shown. That is fine until the hub is
 * reachable from somewhere else (a tailnet, a bound LAN address), at which
 * point the operator needs credentials they actually know to get in from a
 * browser. This is where they set them.
 *
 * While the account still carries that generated password the hub reports
 * `passwordSet: false` and skips its current-password check — there is nothing
 * to confirm against. Once a password is chosen, every later change asks for
 * the current one.
 */
export function AccountSection() {
  const me = useMe()
  const update = useUpdateAccount()
  const user = me.data

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')

  // Seeded once the account arrives, and re-seeded after a save so the field
  // reflects what the hub actually stored (it trims what it is given).
  useEffect(() => {
    if (user) setEmail(user.email)
  }, [user])

  if (me.isPending) {
    return (
      <p className="inline-flex items-center gap-2 font-mono text-[11px] text-devdeck-fg-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Reading account…
      </p>
    )
  }

  if (me.isError || !user) {
    return (
      <p className="font-mono text-[11px] text-devdeck-err">
        {me.error instanceof Error ? me.error.message : 'Failed to read this hub’s operator account.'}
      </p>
    )
  }

  const trimmedEmail = email.trim()
  const emailChanged = trimmedEmail !== user.email
  const emailValid = /^[^\s@]+@[^\s@]+$/.test(trimmedEmail)
  const passwordChanged = password.length > 0
  const passwordLongEnough = password.length >= MIN_PASSWORD_LENGTH
  const passwordsMatch = password === confirm
  // Only asked for once the operator has a password of their own; the
  // generated one was never shown to anybody.
  const needsCurrent = user.passwordSet
  const dirty = emailChanged || passwordChanged
  const valid =
    dirty &&
    (!emailChanged || emailValid) &&
    (!passwordChanged || (passwordLongEnough && passwordsMatch)) &&
    (!needsCurrent || currentPassword.length > 0)

  function save() {
    if (!valid || update.isPending) return
    const body: UpdateAccountBody = {}
    if (emailChanged) body.email = trimmedEmail
    if (passwordChanged) body.password = password
    if (needsCurrent) body.currentPassword = currentPassword
    update.mutate(body, {
      onSuccess: () => {
        setPassword('')
        setConfirm('')
        setCurrentPassword('')
        toast.success(passwordChanged ? 'Sign-in credentials updated' : 'Email updated')
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update the account'),
    })
  }

  const busy = update.isPending

  return (
    <div className="space-y-3">
      {!user.passwordSet ? (
        <div className="flex items-start gap-2 rounded-lg border border-devdeck-border bg-devdeck-pane px-3.5 py-3">
          <TriangleAlert size={14} className="mt-0.5 flex-none text-devdeck-wait" />
          <p className="text-[11px] text-devdeck-fg-2">
            This account still has the placeholder the desktop app created for itself, so nobody can sign in to this
            hub from a browser. Set an email and password here to be able to.
          </p>
        </div>
      ) : null}

      <div>
        <Label>Email</Label>
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          type="email"
          autoComplete="username"
          spellCheck={false}
          placeholder="you@example.com"
          className="font-mono text-[12px]"
          aria-label="Sign-in email"
        />
        {emailChanged && !emailValid ? (
          <p className="mt-1.5 font-mono text-[11px] text-devdeck-err">Not an email address.</p>
        ) : null}
      </div>

      <div>
        <Label>New password</Label>
        <Input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          type="password"
          autoComplete="new-password"
          placeholder={user.passwordSet ? 'leave blank to keep the current one' : `at least ${MIN_PASSWORD_LENGTH} characters`}
          className="font-mono text-[12px]"
          aria-label="New password"
        />
        {passwordChanged && !passwordLongEnough ? (
          <p className="mt-1.5 font-mono text-[11px] text-devdeck-err">
            At least {MIN_PASSWORD_LENGTH} characters. Length beats punctuation - a phrase is fine.
          </p>
        ) : null}
      </div>

      {passwordChanged ? (
        <div>
          <Label>Confirm new password</Label>
          <Input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
            type="password"
            autoComplete="new-password"
            className="font-mono text-[12px]"
            aria-label="Confirm new password"
          />
          {confirm.length > 0 && !passwordsMatch ? (
            <p className="mt-1.5 font-mono text-[11px] text-devdeck-err">The two passwords do not match.</p>
          ) : null}
        </div>
      ) : null}

      {needsCurrent ? (
        <div>
          <Label>Current password</Label>
          <Input
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={busy}
            type="password"
            autoComplete="current-password"
            placeholder="confirms this change"
            className="font-mono text-[12px]"
            aria-label="Current password"
          />
        </div>
      ) : null}

      {passwordChanged ? (
        <div className="flex items-start gap-2 rounded-lg border border-devdeck-border bg-devdeck-pane px-3.5 py-3">
          <TriangleAlert size={14} className="mt-0.5 flex-none text-devdeck-wait" />
          <p className="text-[11px] text-devdeck-fg-2">
            Changing the password signs out every other browser and device signed in to this hub. This window stays
            signed in.
          </p>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-devdeck-fg-2">
          {dirty
            ? 'Applies immediately - no restart.'
            : 'These are the credentials for signing in to this hub from a browser.'}
        </p>
        <Button onClick={save} disabled={!valid || busy} className="flex-none">
          {busy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
