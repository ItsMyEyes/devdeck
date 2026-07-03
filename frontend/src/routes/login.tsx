import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api'
import { useLogin, useVerifyTotp } from '@/features/data/authQueries'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const login = useLogin()
  const verifyTotp = useVerifyTotp()
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submitCredentials() {
    setError(null)
    login.mutate(
      { email, password },
      {
        onSuccess: () => setStep('totp'),
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Login failed'),
      },
    )
  }

  function submitTotp() {
    setError(null)
    verifyTotp.mutate(
      { code },
      {
        onSuccess: () => navigate({ to: '/' }),
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Invalid code'),
      },
    )
  }

  const lockedUntilMatch = error?.match(/until (\S+)/)

  return (
    <div className="flex h-screen w-full items-center justify-center bg-loom-bg text-loom-fg">
      <div className="w-[360px]">
        <h1 className="mb-6 text-lg font-medium">Sign in to Loom</h1>

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
            {error && (
              <p className="mb-4 text-[12px] text-loom-red-soft">
                {lockedUntilMatch ? `Too many attempts. Try again after ${lockedUntilMatch[1]}.` : error}
              </p>
            )}
            <Button onClick={submitCredentials} disabled={login.isPending} className="w-full">
              {login.isPending ? 'Signing in…' : 'Continue →'}
            </Button>
            <p className="mt-4 text-center text-[12px] text-loom-muted">
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
            {error && <p className="mb-4 text-[12px] text-loom-red-soft">{error}</p>}
            <Button onClick={submitTotp} disabled={verifyTotp.isPending} className="w-full">
              {verifyTotp.isPending ? 'Verifying…' : 'Verify →'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
