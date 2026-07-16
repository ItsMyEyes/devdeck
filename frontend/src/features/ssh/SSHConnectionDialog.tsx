import { useRef, useState, type ChangeEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import {
  useCreateSSHConnection,
  useMachines,
  useMachinesHealth,
  useSSHConnections,
  useUpdateSSHConnection,
} from '@/features/data/queries'
import type { CreateSSHConnectionBody, UpdateSSHConnectionBody } from '@/lib/api'
import { useLoomStore } from '@/store/useLoomStore'

const AUTH_OPTIONS = [
  { value: 'password', label: 'Password' },
  { value: 'privatekey', label: 'Private key' },
]

const HUB_DECIDES = ''
const DIRECT = ''

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
  return `ssh-rsa ${bytesToBase64(body)} loom-generated`
}

export function SSHConnectionDialog() {
  const dialog = useLoomStore((s) => s.sshDialog)
  const setDialog = useLoomStore((s) => s.setSSHDialog)
  const close = useLoomStore((s) => s.closeSSHDialog)
  const showToast = useLoomStore((s) => s.showToast)
  const createConnection = useCreateSSHConnection()
  const updateConnection = useUpdateSSHConnection()
  const machines = useMachines().data ?? []
  const machineHealth = useMachinesHealth(machines)
  const connections = useSSHConnections().data ?? []
  const [generatedPublicKey, setGeneratedPublicKey] = useState<string | null>(null)
  const privateKeyInputRef = useRef<HTMLInputElement | null>(null)

  const isEdit = dialog.editingId !== null
  const busy = createConnection.isPending || updateConnection.isPending
  const portNum = Number.parseInt(dialog.port, 10)
  const portOK = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535
  // On create the auth secret is required; on edit a blank secret means "keep the stored one".
  const secretOK =
    isEdit || (dialog.authType === 'password' ? dialog.password.length > 0 : Boolean(dialog.privateKey || dialog.privateKeyPath))
  const canSubmit =
    dialog.name.trim().length > 0 &&
    dialog.host.trim().length > 0 &&
    dialog.username.trim().length > 0 &&
    portOK &&
    secretOK &&
    !busy

  const machineOptions = [
    { value: HUB_DECIDES, label: 'Hub decides' },
    ...machines.map((m) => ({
      value: m.id,
      label: m.isLocal ? `${m.name} (local)` : m.name,
      disabled: machineHealth.get(m.id)?.status === 'offline',
    })),
  ]
  // A connection can't jump through itself. The backend re-validates the
  // full chain authoritatively (including deeper cycles); this just keeps
  // the one obviously-cyclic choice out of the list.
  const jumpOptions = [
    { value: DIRECT, label: 'Direct connection' },
    ...connections.filter((c) => c.id !== dialog.editingId).map((c) => ({ value: c.id, label: c.name })),
  ]

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
      setDialog({ authType: 'privatekey', privateKey: text, privateKeyPath: '' })
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
      setDialog({ authType: 'privatekey', privateKey: pemBlock('PRIVATE KEY', privateDer), privateKeyPath: '' })
      setGeneratedPublicKey(sshRsaPublicKey(publicJwk))
      showToast('Generated SSH key — copy the public key to the host before connecting')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to generate SSH key')
    }
  }

  function copyGeneratedPublicKey() {
    if (!generatedPublicKey) return
    void navigator.clipboard.writeText(generatedPublicKey)
    showToast('Copied generated public key')
  }

  function submit() {
    if (!canSubmit) return
    const base: CreateSSHConnectionBody = {
      name: dialog.name.trim(),
      group: dialog.group.trim(),
      host: dialog.host.trim(),
      port: portNum,
      username: dialog.username.trim(),
      authType: dialog.authType,
      executorMachineId: dialog.executorMachineId || null,
      jumpConnectionId: dialog.jumpConnectionId || null,
    }
    const secrets: UpdateSSHConnectionBody = {}
    if (dialog.password) secrets.password = dialog.password
    if (dialog.privateKey) secrets.privateKey = dialog.privateKey
    else if (dialog.privateKeyPath) secrets.privateKeyPath = dialog.privateKeyPath
    if (dialog.passphrase) secrets.passphrase = dialog.passphrase

    const onError = (err: unknown) =>
      showToast(err instanceof Error ? err.message : 'Failed to save SSH connection')

    if (dialog.editingId) {
      updateConnection.mutate(
        { id: dialog.editingId, patch: { ...base, ...secrets } },
        {
          onSuccess: () => {
            close()
            showToast(`Updated SSH connection "${base.name}"`)
          },
          onError,
        },
      )
    } else {
      const body: CreateSSHConnectionBody = { ...base, ...secrets }
      createConnection.mutate(body, {
        onSuccess: () => {
          close()
          showToast(`Added SSH connection "${base.name}"`)
        },
        onError,
      })
    }
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={480}>
      <DialogTitle>{isEdit ? 'Edit SSH connection' : 'Add SSH connection'}</DialogTitle>
      <DialogDescription className="mb-[18px]">
        Any SSH host — not limited to registered machines. Credentials are encrypted at rest and never sent back
        to the browser.
      </DialogDescription>

      <Label>Name</Label>
      <Input
        value={dialog.name}
        disabled={busy}
        onChange={(e) => setDialog({ name: e.target.value })}
        placeholder="prod-web"
        className="mb-3 font-mono"
      />

      <Label>Group</Label>
      <Input
        value={dialog.group}
        disabled={busy}
        onChange={(e) => setDialog({ group: e.target.value })}
        placeholder="Production"
        className="mb-3 font-mono"
      />

      <div className="mb-3 flex gap-3">
        <div className="min-w-0 flex-1">
          <Label>Host</Label>
          <Input
            value={dialog.host}
            disabled={busy}
            onChange={(e) => setDialog({ host: e.target.value })}
            placeholder="web.example.com"
            className="font-mono"
          />
        </div>
        <div className="w-[90px] flex-none">
          <Label>Port</Label>
          <Input
            value={dialog.port}
            disabled={busy}
            onChange={(e) => setDialog({ port: e.target.value })}
            placeholder="22"
            className="font-mono"
          />
        </div>
      </div>

      <Label>Username</Label>
      <Input
        value={dialog.username}
        disabled={busy}
        onChange={(e) => setDialog({ username: e.target.value })}
        placeholder="deploy"
        className="mb-3 font-mono"
      />

      <Label>Auth</Label>
      <Select
        value={dialog.authType}
        onValueChange={(v) => setDialog({ authType: v as 'password' | 'privatekey' })}
        options={AUTH_OPTIONS}
        disabled={busy}
        aria-label="Auth method"
      />

      {dialog.authType === 'password' ? (
        <div className="mt-3">
          <Label>Password</Label>
          <Input
            value={dialog.password}
            disabled={busy}
            type="password"
            onChange={(e) => setDialog({ password: e.target.value })}
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
              <Button variant="secondary" size="sm" onClick={selectPrivateKeyFile} disabled={busy}>
                Select key
              </Button>
              <Button variant="ghost" size="sm" onClick={generatePrivateKey} disabled={busy}>
                Generate
              </Button>
            </div>
          </div>
          <Input
            value={dialog.privateKeyPath}
            disabled={busy || Boolean(dialog.privateKey)}
            onChange={(e) => setDialog({ privateKeyPath: e.target.value })}
            placeholder="~/.ssh/id_ed25519"
            className="mb-2.5 font-mono"
          />
          <textarea
            value={dialog.privateKey}
            disabled={busy}
            onChange={(e) => setDialog({ privateKey: e.target.value, privateKeyPath: '' })}
            placeholder={isEdit ? 'unchanged' : 'select ~/.ssh/id_ed25519, paste PEM, or generate a key'}
            rows={4}
            className="w-full resize-y rounded-lg border border-loom-border-strong bg-loom-bg px-2.5 py-2 font-mono text-[11px] text-loom-fg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          {generatedPublicKey ? (
            <div className="mt-2.5 rounded-lg border border-loom-border-strong bg-loom-bg p-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-loom-muted">Generated public key</span>
                <Button variant="ghost" size="sm" onClick={copyGeneratedPublicKey}>
                  Copy
                </Button>
              </div>
              <code className="block break-all font-mono text-[10.5px] leading-relaxed text-loom-fg-2">{generatedPublicKey}</code>
              <p className="mt-1.5 text-[10.5px] leading-snug text-loom-dim">
                Add this public key to the host's ~/.ssh/authorized_keys before connecting.
              </p>
            </div>
          ) : null}
          <Label className="mt-3">Passphrase (optional)</Label>
          <Input
            value={dialog.passphrase}
            disabled={busy}
            type="password"
            onChange={(e) => setDialog({ passphrase: e.target.value })}
            placeholder={isEdit ? 'unchanged' : ''}
            className="mb-5 font-mono"
          />
        </div>
      )}

      <div className="mb-5 rounded-[12px] border border-loom-border-card bg-loom-surface-2 p-3">
        <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-loom-dim">Connection flow</div>

        <Label>1. Executor machine</Label>
        <Select
          value={dialog.executorMachineId}
          onValueChange={(v) => setDialog({ executorMachineId: v })}
          options={machineOptions}
          disabled={busy}
          aria-label="Executor machine"
          className="mb-3"
        />

        <Label>2. Connect via</Label>
        <Select
          value={dialog.jumpConnectionId}
          onValueChange={(v) => setDialog({ jumpConnectionId: v })}
          options={jumpOptions}
          disabled={busy}
          aria-label="Connect via"
        />
        <p className="mt-1.5 text-[11px] leading-snug text-loom-dim">
          {dialog.jumpConnectionId
            ? 'The executor dials the jump host first, then tunnels the SSH handshake through it to reach this host.'
            : 'The executor dials this host directly.'}
        </p>
      </div>

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          {isEdit ? 'Save' : 'Add'}
        </Button>
      </div>
    </Dialog>
  )
}
