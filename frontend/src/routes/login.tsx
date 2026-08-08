import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api'
import { useAuthConfig, useLogin, useVerifyTotp } from '@/features/data/authQueries'
import { TurnstileWidget } from '@/features/auth/TurnstileWidget'

interface LoginSearch {
  next?: string
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    next: typeof search.next === 'string' ? search.next : undefined,
  }),
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const { next } = Route.useSearch()
  const login = useLogin()
  const verifyTotp = useVerifyTotp()
  const authConfig = useAuthConfig()
  const turnstileSiteKey = authConfig.data?.turnstileSiteKey ?? ''
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  // Turnstile tokens are single-use; bump the key to remount the widget
  // after a failed login consumed the token server-side.
  const [turnstileKey, setTurnstileKey] = useState(0)

  function goNext() {
    if (next) {
      window.location.href = next // may be a different route entirely (e.g. /handover?...); a full navigation keeps this simple and correct either way
    } else {
      navigate({ to: '/' })
    }
  }

  function submitCredentials() {
    setError(null)
    login.mutate(
      { email, password, turnstileToken: turnstileToken ?? undefined },
      {
        // status 'ok' means the server runs with --2fa=false and the
        // session cookie is already set; there is no TOTP step.
        onSuccess: (data) => (data.status === 'ok' ? goNext() : setStep('totp')),
        onError: (err) => {
          setError(err instanceof ApiError ? err.message : 'Login failed')
          if (turnstileSiteKey) {
            setTurnstileToken(null)
            setTurnstileKey((k) => k + 1)
          }
        },
      },
    )
  }

  function submitTotp() {
    setError(null)
    verifyTotp.mutate(
      { code },
      {
        onSuccess: () => goNext(),
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Invalid code'),
      },
    )
  }

  const lockedUntilMatch = error?.match(/until (.+): locked$/)

  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center bg-devdeck-pane px-4 text-devdeck-fg">
      <div className="w-[360px]">
        <h1 className="mb-6 text-lg font-medium">Sign in to DevDeck</h1>

        {step === 'credentials' && (
          <>
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mb-4"
              autoFocus
            />
            <Label>Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitCredentials()}
              className="mb-5"
            />
            {turnstileSiteKey && (
              <TurnstileWidget key={turnstileKey} siteKey={turnstileSiteKey} onToken={setTurnstileToken} />
            )}
            {error && (
              <p className="mb-4 text-[12px] text-devdeck-err">
                {lockedUntilMatch ? `Too many attempts. Try again after ${lockedUntilMatch[1]}.` : error}
              </p>
            )}
            <Button
              onClick={submitCredentials}
              disabled={login.isPending || (!!turnstileSiteKey && !turnstileToken)}
              className="w-full"
            >
              {login.isPending ? 'Signing in…' : 'Continue →'}
            </Button>
            <p className="mt-4 text-center text-[12px] text-devdeck-fg-2">
              First time? <Link to="/register" className="underline">Create an account</Link>
            </p>
          </>
        )}

        {step === 'totp' && (
          <>
            <Label>Authenticator code</Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitTotp()}
              placeholder="6-digit code or backup code"
              className="mb-5"
              autoFocus
            />
            {error && <p className="mb-4 text-[12px] text-devdeck-err">{error}</p>}
            <Button onClick={submitTotp} disabled={verifyTotp.isPending} className="w-full">
              {verifyTotp.isPending ? 'Verifying…' : 'Verify →'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
