import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api'
import { useSetupTotp, useVerifyTotpSetup } from '@/features/data/authQueries'

export const Route = createFileRoute('/2fa-setup')({
  component: TotpSetupPage,
})

function TotpSetupPage() {
  const navigate = useNavigate()
  const setupTotp = useSetupTotp()
  const verifyTotpSetup = useVerifyTotpSetup()
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)

  useEffect(() => {
    setupTotp.mutate(undefined, {
      onSuccess: async (res) => {
        setQrDataUrl(await QRCode.toDataURL(res.otpauthUri))
      },
      onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not start 2FA setup'),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function submit() {
    setError(null)
    verifyTotpSetup.mutate(
      { code },
      {
        onSuccess: (res) => setBackupCodes(res.backupCodes),
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Invalid code'),
      },
    )
  }

  if (backupCodes) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-loom-bg text-loom-fg">
        <div className="w-[400px]">
          <h1 className="mb-1 text-lg font-medium">Save your backup codes</h1>
          <p className="mb-4 text-[12px] text-loom-muted">
            Each code works once, if you lose your authenticator. They will not be shown again.
          </p>
          <div className="mb-6 grid grid-cols-2 gap-2 rounded-lg border border-loom-border-strong bg-loom-elevated p-3 font-mono text-[12.5px]">
            {backupCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <Button onClick={() => navigate({ to: '/login' })} className="w-full">
            I've saved these — sign in →
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-loom-bg text-loom-fg">
      <div className="w-[360px]">
        <h1 className="mb-1 text-lg font-medium">Set up two-factor authentication</h1>
        <p className="mb-4 text-[12px] text-loom-muted">
          Scan this QR code with an authenticator app (Google Authenticator, Authy, 1Password).
        </p>
        {qrDataUrl && (
          <img src={qrDataUrl} alt="TOTP QR code" className="mb-4 h-[200px] w-[200px] rounded-lg bg-white p-2" />
        )}
        <Label>6-digit code</Label>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="mb-5"
          autoFocus
        />
        {error && <p className="mb-4 text-[12px] text-loom-red-soft">{error}</p>}
        <Button onClick={submit} disabled={verifyTotpSetup.isPending} className="w-full">
          {verifyTotpSetup.isPending ? 'Verifying…' : 'Enable 2FA →'}
        </Button>
      </div>
    </div>
  )
}
