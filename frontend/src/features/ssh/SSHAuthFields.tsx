import { useRef, useState, type ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const AUTH_OPTIONS = [
  { value: 'password', label: 'Password' },
  { value: 'privatekey', label: 'Private key' },
]

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function pemBlock(label: string, buffer: ArrayBuffer) {
  const base64 = arrayBufferToBase64(buffer)
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

function base64UrlToBytes(value: string) {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function uint32Bytes(value: number) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])
}

function concatBytes(...chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function sshString(bytes: Uint8Array) {
  return concatBytes(uint32Bytes(bytes.length), bytes)
}

function sshMpint(bytes: Uint8Array) {
  const firstNonZero = bytes.findIndex((byte) => byte !== 0)
  const trimmed = firstNonZero === -1 ? new Uint8Array([0]) : bytes.slice(firstNonZero)
  return trimmed[0] & 0x80 ? concatBytes(new Uint8Array([0]), trimmed) : trimmed
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function sshRsaPublicKey(jwk: JsonWebKey) {
  if (!jwk.e || !jwk.n) throw new Error('Generated key is missing RSA parameters')
  const encoder = new TextEncoder()
  const body = concatBytes(
    sshString(encoder.encode('ssh-rsa')),
    sshString(sshMpint(base64UrlToBytes(jwk.e))),
    sshString(sshMpint(base64UrlToBytes(jwk.n))),
  )
  return `ssh-rsa ${bytesToBase64(body)} devdeck-generated`
}

export interface SSHAuthFieldsValue {
  authType: 'password' | 'privatekey'
  password: string
  privateKey: string
  privateKeyPath: string
  passphrase: string
}

interface SSHAuthFieldsProps extends SSHAuthFieldsValue {
  onChange: (patch: Partial<SSHAuthFieldsValue>) => void
  disabled?: boolean
  isEdit?: boolean
}

/** Auth-method fields (password, or private key with file-select/generate/
 *  passphrase) shared by SSHConnectionDialog's main form and its inline
 *  "add a new jump host" mini-form. */
export function SSHAuthFields({ authType, password, privateKey, privateKeyPath, passphrase, onChange, disabled, isEdit }: SSHAuthFieldsProps) {
  const showToast = useDevDeckStore((s) => s.showToast)
  const [generatedPublicKey, setGeneratedPublicKey] = useState<string | null>(null)
  const privateKeyInputRef = useRef<HTMLInputElement | null>(null)

  function selectPrivateKeyFile() {
    privateKeyInputRef.current?.click()
  }

  function handlePrivateKeyFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      onChange({ authType: 'privatekey', privateKey: text, privateKeyPath: '' })
      setGeneratedPublicKey(null)
      showToast(`Loaded private key "${file.name}"`)
      input.value = ''
    }
    reader.onerror = () => showToast('Failed to read private key')
    reader.readAsText(file)
  }

  async function generatePrivateKey() {
    try {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
      )
      const [privateDer, publicJwk] = await Promise.all([
        crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
        crypto.subtle.exportKey('jwk', keyPair.publicKey),
      ])
      onChange({ authType: 'privatekey', privateKey: pemBlock('PRIVATE KEY', privateDer), privateKeyPath: '' })
      setGeneratedPublicKey(sshRsaPublicKey(publicJwk))
      showToast('Generated SSH key - copy the public key to the host before connecting')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to generate SSH key')
    }
  }

  function copyGeneratedPublicKey() {
    if (!generatedPublicKey) return
    void navigator.clipboard.writeText(generatedPublicKey)
    showToast('Copied generated public key')
  }

  return (
    <>
      <Label>Auth</Label>
      <Select
        value={authType}
        onValueChange={(v) => onChange({ authType: v as 'password' | 'privatekey' })}
        options={AUTH_OPTIONS}
        disabled={disabled}
        aria-label="Auth method"
      />

      {authType === 'password' ? (
        <div className="mt-3">
          <Label>Password</Label>
          <Input
            value={password}
            disabled={disabled}
            type="password"
            onChange={(e) => onChange({ password: e.target.value })}
            placeholder={isEdit ? 'unchanged' : ''}
            className="mb-5 font-mono"
          />
        </div>
      ) : (
        <div className="mt-3">
          <input ref={privateKeyInputRef} type="file" className="hidden" accept=".pem,.key,.txt,*" onChange={handlePrivateKeyFile} />
          <div className="mb-2 flex items-center justify-between gap-2">
            <Label className="mb-0">Private key (PEM / ~/.ssh)</Label>
            <div className="flex items-center gap-1.5">
              <Button variant="secondary" size="sm" onClick={selectPrivateKeyFile} disabled={disabled}>
                Select key
              </Button>
              <Button variant="ghost" size="sm" onClick={generatePrivateKey} disabled={disabled}>
                Generate
              </Button>
            </div>
          </div>
          <Input
            value={privateKeyPath}
            disabled={disabled || Boolean(privateKey)}
            onChange={(e) => onChange({ privateKeyPath: e.target.value })}
            placeholder="~/.ssh/id_ed25519"
            className="mb-2.5 font-mono"
          />
          <textarea
            value={privateKey}
            disabled={disabled}
            onChange={(e) => onChange({ privateKey: e.target.value, privateKeyPath: '' })}
            placeholder={isEdit ? 'unchanged' : 'select ~/.ssh/id_ed25519, paste PEM, or generate a key'}
            rows={4}
            className="w-full resize-y rounded-lg border border-devdeck-border-strong bg-devdeck-pane px-2.5 py-2 font-mono text-[11px] text-devdeck-fg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          {generatedPublicKey ? (
            <div className="mt-2.5 rounded-lg border border-devdeck-border-strong bg-devdeck-pane p-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-devdeck-fg-2">Generated public key</span>
                <Button variant="ghost" size="sm" onClick={copyGeneratedPublicKey}>
                  Copy
                </Button>
              </div>
              <code className="block break-all font-mono text-[10.5px] leading-relaxed text-devdeck-fg-2">{generatedPublicKey}</code>
              <p className="mt-1.5 text-[10.5px] leading-snug text-devdeck-fg-2">
                Add this public key to the host's ~/.ssh/authorized_keys before connecting.
              </p>
            </div>
          ) : null}
          <Label className="mt-3">Passphrase (optional)</Label>
          <Input
            value={passphrase}
            disabled={disabled}
            type="password"
            onChange={(e) => onChange({ passphrase: e.target.value })}
            placeholder={isEdit ? 'unchanged' : ''}
            className="mb-5 font-mono"
          />
        </div>
      )}
    </>
  )
}
