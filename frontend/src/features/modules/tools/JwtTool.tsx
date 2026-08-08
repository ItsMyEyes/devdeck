import { useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { AlertTriangle, Copy, KeyRound, ShieldAlert, ShieldCheck, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { highlightJsonHtml } from '@/lib/formatters'
import { decodeJwt, JWT_ALGORITHMS, jwtKeyFamily, signJwt, verifyJwt, type JwtAlgorithm } from '@/lib/jwt'
import { cn } from '@/lib/utils'
import { ModeTabs } from './ModeTabs'
import { ToolCard } from './ToolCard'

const ALG_OPTIONS = JWT_ALGORITHMS.map((a) => ({ value: a, label: a }))

const SAMPLE_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFuZGkgU3lhaHJ1ZGRpbiIsImlhdCI6MTUxNjIzOTAyMn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

function claimDates(payload: unknown): { key: string; value: string }[] {
  if (!payload || typeof payload !== 'object') return []
  const obj = payload as Record<string, unknown>
  const out: { key: string; value: string }[] = []
  for (const key of ['iat', 'nbf', 'exp']) {
    const v = obj[key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      const d = new Date(v * 1000)
      out.push({ key, value: `${d.toISOString()} · ${formatDistanceToNow(d, { addSuffix: true })}` })
    }
  }
  return out
}

function DecodePanel() {
  const [token, setToken] = useState(SAMPLE_TOKEN)
  const [key, setKey] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ valid: boolean; alg: string } | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  const decoded = useMemo(() => {
    if (!token.trim()) return null
    try {
      return { value: decodeJwt(token), error: null as string | null }
    } catch (err) {
      return { value: null, error: err instanceof Error ? err.message : 'Invalid token' }
    }
  }, [token])

  const family = decoded?.value ? jwtKeyFamily(decoded.value.alg) : null

  function onTokenChange(next: string) {
    setToken(next)
    setVerifyResult(null)
    setVerifyError(null)
  }

  async function verify() {
    setVerifying(true)
    setVerifyResult(null)
    setVerifyError(null)
    try {
      const result = await verifyJwt(token, key)
      setVerifyResult(result)
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Verification failed')
    } finally {
      setVerifying(false)
    }
  }

  const parts = token.trim().split('.')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10.5px] tracking-wide text-devdeck-fg-2 uppercase">Token</span>
        <Textarea
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="Paste a JWT (header.payload.signature)…"
          className="min-h-[70px] font-mono text-[11px] break-all"
          spellCheck={false}
        />
        {parts.length === 3 ? (
          <div className="overflow-x-auto rounded-lg border border-devdeck-border-card bg-devdeck-pane px-2.5 py-2 font-mono text-[10.5px] break-all">
            <span className="text-devdeck-err">{parts[0]}</span>
            <span className="text-devdeck-fg-2">.</span>
            <span className="text-devdeck-purple">{parts[1]}</span>
            <span className="text-devdeck-fg-2">.</span>
            <span className="text-devdeck-accent">{parts[2]}</span>
          </div>
        ) : null}
      </div>

      {!decoded ? null : decoded.error ? (
        <div className="flex items-start gap-2 rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint/40 p-3">
          <AlertTriangle size={14} className="mt-0.5 flex-none text-devdeck-err" />
          <div className="font-mono text-[11px] text-devdeck-fg-2">{decoded.error}</div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="flex min-h-0 flex-col gap-1.5">
            <span className="font-mono text-[10.5px] tracking-wide text-devdeck-fg-2 uppercase">Header</span>
            <pre
              className="min-h-[80px] flex-1 overflow-auto rounded-lg border border-devdeck-border-card bg-devdeck-pane p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
              // eslint-disable-next-line react/no-danger -- highlightJsonHtml HTML-escapes the source before wrapping matched tokens in fixed-class spans.
              dangerouslySetInnerHTML={{ __html: highlightJsonHtml(JSON.stringify(decoded.value?.header, null, 2)) }}
            />
          </div>
          <div className="flex min-h-0 flex-col gap-1.5">
            <span className="font-mono text-[10.5px] tracking-wide text-devdeck-fg-2 uppercase">Payload</span>
            <pre
              className="min-h-[80px] flex-1 overflow-auto rounded-lg border border-devdeck-border-card bg-devdeck-pane p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
              // eslint-disable-next-line react/no-danger -- highlightJsonHtml HTML-escapes the source before wrapping matched tokens in fixed-class spans.
              dangerouslySetInnerHTML={{ __html: highlightJsonHtml(JSON.stringify(decoded.value?.payload, null, 2)) }}
            />
            {claimDates(decoded.value?.payload).map((c) => (
              <div key={c.key} className="font-mono text-[10.5px] text-devdeck-fg-2">
                <span className="text-devdeck-fg-2 uppercase">{c.key}</span> - {c.value}
              </div>
            ))}
          </div>
        </div>
      )}

      {decoded?.value ? (
        <div className="flex flex-none flex-col gap-2 rounded-lg border border-devdeck-border-card p-3">
          <div className="flex items-center gap-2">
            <KeyRound size={13} className="text-devdeck-fg-2" />
            <span className="text-[11.5px] font-medium text-devdeck-fg">Verify signature</span>
            <span className="font-mono text-[10.5px] text-devdeck-fg-2">alg: {decoded.value.alg ?? 'unknown'}</span>
          </div>
          {!family ? (
            <div className="font-mono text-[11px] text-devdeck-fg-2">
              Verification isn't supported for this algorithm here - only HS256/384/512 and RS256/384/512.
            </div>
          ) : (
            <>
              <Textarea
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={family === 'hmac' ? 'HMAC secret string…' : '-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----'}
                className="min-h-[60px] font-mono text-[11px]"
                spellCheck={false}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={verify} disabled={verifying || !key.trim()}>
                  {verifying ? 'Verifying…' : 'Verify signature'}
                </Button>
                {verifyResult ? (
                  verifyResult.valid ? (
                    <span className="flex items-center gap-1 font-mono text-[11px] text-devdeck-run">
                      <ShieldCheck size={13} />
                      Valid signature
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 font-mono text-[11px] text-devdeck-err">
                      <ShieldAlert size={13} />
                      Invalid signature
                    </span>
                  )
                ) : null}
                {verifyError ? <span className="font-mono text-[11px] text-devdeck-err">{verifyError}</span> : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function EncodePanel() {
  const [alg, setAlg] = useState<JwtAlgorithm>('HS256')
  const [payloadText, setPayloadText] = useState(() =>
    JSON.stringify({ sub: '1234567890', name: 'Andi Syahruddin', iat: Math.floor(Date.now() / 1000) }, null, 2),
  )
  const [key, setKey] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signing, setSigning] = useState(false)

  const family = jwtKeyFamily(alg)

  async function generate() {
    setError(null)
    setToken(null)
    let payload: unknown
    try {
      payload = JSON.parse(payloadText)
    } catch {
      setError('Payload must be valid JSON')
      return
    }
    if (!key.trim()) {
      setError(family === 'hmac' ? 'A secret is required' : 'A private key (PEM) is required')
      return
    }
    setSigning(true)
    try {
      setToken(await signJwt({ alg, payload, key }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign token')
    } finally {
      setSigning(false)
    }
  }

  function copyToken() {
    if (!token) return
    void navigator.clipboard.writeText(token)
    toast.success('Token copied')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-[10.5px] tracking-wide text-devdeck-fg-2 uppercase">Algorithm</span>
        <Select value={alg} onValueChange={(v) => setAlg(v as JwtAlgorithm)} options={ALG_OPTIONS} className="w-[110px]" aria-label="Algorithm" />
        <span className="font-mono text-[10.5px] text-devdeck-fg-2">
          {family === 'hmac' ? 'HMAC - shared secret string' : 'RSA - private key from openssl genrsa (PKCS1) or PKCS8'}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="flex min-h-[160px] flex-col gap-1.5">
          <span className="font-mono text-[10.5px] tracking-wide text-devdeck-fg-2 uppercase">Payload (JSON)</span>
          <Textarea
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            className="min-h-[160px] flex-1 font-mono text-[11.5px]"
            spellCheck={false}
          />
        </div>
        <div className="flex min-h-[160px] flex-col gap-1.5">
          <span className="font-mono text-[10.5px] tracking-wide text-devdeck-fg-2 uppercase">
            {family === 'hmac' ? 'Secret' : 'Private key (PEM)'}
          </span>
          <Textarea
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={family === 'hmac' ? 'your-256-bit-secret' : '-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----'}
            className={cn('min-h-[160px] flex-1 font-mono text-[11.5px]', family === 'rsa' && 'text-[10.5px]')}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="flex flex-none items-center gap-2">
        <Button size="sm" onClick={generate} disabled={signing}>
          <Wand2 size={12} />
          {signing ? 'Signing…' : 'Generate token'}
        </Button>
        {error ? <span className="font-mono text-[11px] text-devdeck-err">{error}</span> : null}
      </div>

      {token ? (
        <div className="flex flex-none flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10.5px] tracking-wide text-devdeck-fg-2 uppercase">Token</span>
            <Button variant="ghost" size="sm" onClick={copyToken}>
              <Copy size={12} />
              Copy
            </Button>
          </div>
          <pre className="overflow-auto rounded-lg border border-devdeck-border-card bg-devdeck-pane p-2.5 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
            {token}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

/** Decode/inspect a JWT (with optional signature verification) or sign a new one — HMAC secret or RSA/OpenSSL PEM keys. */
export function JwtTool() {
  const [mode, setMode] = useState<'decode' | 'encode'>('decode')

  return (
    <ToolCard
      title="JWT Encode / Decode"
      description="Inspect and verify tokens, or sign new ones with an HMAC secret or an RSA (OpenSSL) key pair."
      actions={
        <ModeTabs
          value={mode}
          onChange={setMode}
          options={[
            { value: 'decode', label: 'Decode' },
            { value: 'encode', label: 'Encode' },
          ]}
        />
      }
    >
      {mode === 'decode' ? <DecodePanel /> : <EncodePanel />}
    </ToolCard>
  )
}
