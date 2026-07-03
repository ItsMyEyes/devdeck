import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api'
import { useAuthConfig, useRegister } from '@/features/data/authQueries'

export const Route = createFileRoute('/register')({
  component: RegisterPage,
})

function RegisterPage() {
  const navigate = useNavigate()
  const register = useRegister()
  const authConfig = useAuthConfig()
  const totpRequired = authConfig.data?.totpRequired ?? true
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit() {
    setError(null)
    register.mutate(
      { email, password },
      {
        // With --2fa=false the register response already set a session
        // cookie, so enrollment is skipped and the app opens directly.
        onSuccess: () => navigate({ to: totpRequired ? '/2fa-setup' : '/' }),
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Registration failed'),
      },
    )
  }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-loom-bg text-loom-fg">
      <div className="w-[360px]">
        <h1 className="mb-1 text-lg font-medium">Create the Loom operator account</h1>
        <p className="mb-6 text-[12px] text-loom-muted">
          One account per install.{totpRequired ? ' Two-factor setup is required next.' : ''}
        </p>
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
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="at least 12 characters"
          className="mb-5"
        />
        {error && <p className="mb-4 text-[12px] text-loom-red-soft">{error}</p>}
        <Button onClick={submit} disabled={register.isPending} className="w-full">
          {register.isPending ? 'Creating…' : 'Create account →'}
        </Button>
        <p className="mt-4 text-center text-[12px] text-loom-muted">
          Already have an account? <Link to="/login" className="underline">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
