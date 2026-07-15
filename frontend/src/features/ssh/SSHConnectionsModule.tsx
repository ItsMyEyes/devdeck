import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode, RefObject } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  Cable,
  Fingerprint,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { DataLoading } from '@/features/screens/DataLoading'
import { useScope } from '@/features/useScope'
import { cn } from '@/lib/utils'
import type { CreateSSHConnectionBody, UpdateSSHConnectionBody } from '@/lib/api'
import type { SSHConnection } from '@/store/types'
import {
  useAcceptSSHHostKey,
  useCreateSSHConnection,
  useSSHConnections,
  useUpdateSSHConnection,
} from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

type PanelMode = 'view' | 'create' | 'edit'

type AuthType = SSHConnection['authType']

interface SSHDraft {
  name: string
  host: string
  port: string
  username: string
  authType: AuthType
  password: string
  privateKey: string
  privateKeyPath: string
  passphrase: string
}

const AUTH_OPTIONS = [
  { value: 'password', label: 'Password' },
  { value: 'privatekey', label: 'Private key' },
]

const EMPTY_DRAFT: SSHDraft = {
  name: '',
  host: '',
  port: '22',
  username: '',
  authType: 'password',
  password: '',
  privateKey: '',
  privateKeyPath: '',
  passphrase: '',
}

function draftFromConnection(connection: SSHConnection): SSHDraft {
  return {
    name: connection.name,
    host: connection.host,
    port: String(connection.port),
    username: connection.username,
    authType: connection.authType,
    password: '',
    privateKey: '',
    privateKeyPath: '',
    passphrase: '',
  }
}

function parsePort(value: string) {
  const port = Number.parseInt(value, 10)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

function draftIsValid(draft: SSHDraft, mode: PanelMode) {
  const port = parsePort(draft.port)
  const hasSecret =
    mode === 'edit' ||
    (draft.authType === 'password' ? draft.password.length > 0 : Boolean(draft.privateKey || draft.privateKeyPath))
  return Boolean(draft.name.trim() && draft.host.trim() && draft.username.trim() && port && hasSecret)
}

function authLabel(authType: AuthType) {
  return authType === 'password' ? 'password' : 'private key'
}

function connectionSubtitle(connection: SSHConnection) {
  return `${connection.username}@${connection.host}:${connection.port}`
}

function hostSearchText(connection: SSHConnection) {
  return `${connection.name} ${connection.host} ${connection.port} ${connection.username} ${connection.authType}`.toLowerCase()
}

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

function HostGlyph({ authType, selected = false }: { authType: AuthType; selected?: boolean }) {
  const privateKey = authType === 'privatekey'
  return (
    <span
      className={cn(
        'flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border transition-colors',
        privateKey
          ? 'border-loom-border-accent bg-loom-accent-tint text-loom-accent-soft'
          : 'border-loom-yellow-tint-border bg-loom-yellow-tint text-loom-yellow-soft',
        selected && 'border-loom-accent',
      )}
    >
      {privateKey ? <KeyRound size={16} /> : <Server size={16} />}
    </span>
  )
}

function HostKeyBadge({ connection, compact = false }: { connection: SSHConnection; compact?: boolean }) {
  const acceptHostKey = useAcceptSSHHostKey()
  const showToast = useLoomStore((s) => s.showToast)

  if (!connection.hostKeyFingerprint) {
    return (
      <span className={cn('font-mono text-loom-dim', compact ? 'text-[10px]' : 'text-[10.5px]')}>
        trust on first connect
      </span>
    )
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-loom-dim-2">
      <Fingerprint size={compact ? 10 : 11} className="flex-none" />
      <span className="min-w-0 truncate" title={connection.hostKeyFingerprint}>
        {connection.hostKeyFingerprint}
      </span>
      <button
        type="button"
        aria-label="Reset pinned host key"
        title="Reset pinned host key (re-pins on next connect)"
        onClick={(event) => {
          event.stopPropagation()
          acceptHostKey.mutate(connection.id, {
            onSuccess: () => showToast(`Host key for "${connection.name}" reset — re-pins on next connect`),
          })
        }}
        className="flex-none cursor-pointer rounded p-0.5 text-loom-muted-2 hover:bg-loom-hover-wash hover:text-loom-accent-soft"
      >
        <RotateCcw size={11} />
      </button>
    </span>
  )
}

function GroupCard({ label, count, icon }: { label: string; count: number; icon: ReactNode }) {
  return (
    <div className="flex min-w-[180px] flex-1 items-center gap-3 rounded-[12px] border border-loom-border-card bg-loom-card px-3 py-2.5">
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] border border-loom-border-strong bg-loom-surface-2 text-loom-muted">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-medium text-loom-fg-2">{label}</div>
        <div className="font-mono text-[10.5px] text-loom-dim">
          {count} {count === 1 ? 'host' : 'hosts'}
        </div>
      </div>
    </div>
  )
}

function HostCard({
  connection,
  selected,
  onSelect,
}: {
  connection: SSHConnection
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'group flex min-h-[66px] min-w-0 items-center gap-3 rounded-[12px] border bg-loom-card px-3 py-2.5 text-left transition-colors',
        selected
          ? 'border-loom-accent bg-loom-elevated text-loom-fg'
          : 'border-loom-border-card text-loom-fg-2 hover:border-loom-border-menu hover:bg-loom-surface-2',
      )}
    >
      <HostGlyph authType={connection.authType} selected={selected} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{connection.name}</span>
        <span className="mt-0.5 block truncate font-mono text-[10.5px] text-loom-dim-2">
          {connectionSubtitle(connection)}
        </span>
      </span>
      <span
        className={cn(
          'hidden flex-none rounded-full border px-2 py-0.5 font-mono text-[10px] md:inline-flex',
          selected ? 'border-loom-border-accent text-loom-accent-soft' : 'border-loom-border text-loom-dim',
        )}
      >
        {authLabel(connection.authType)}
      </span>
    </button>
  )
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <Label>{label}</Label>
      <div
        className={cn(
          'flex h-9 items-center rounded-lg border border-loom-border-strong bg-loom-bg px-2.5 text-[12.5px] text-loom-fg-2',
          mono && 'font-mono',
        )}
      >
        <span className="truncate">{value}</span>
      </div>
    </div>
  )
}

function SecretHelp({ mode, authType }: { mode: PanelMode; authType: AuthType }) {
  if (mode === 'create') return null
  return (
    <p className="mt-1.5 text-[11px] leading-snug text-loom-dim">
      Leave {authType === 'password' ? 'password' : 'private key'} blank to keep the stored credential.
    </p>
  )
}

function HostDetailsPanel({
  mode,
  selected,
  draft,
  busy,
  canSave,
  onDraftChange,
  onCreate,
  onEdit,
  onCancel,
  onSave,
  onDelete,
  onConnect,
  privateKeyInputRef,
  generatedPublicKey,
  onSelectPrivateKeyFile,
  onPrivateKeyFile,
  onGeneratePrivateKey,
  onCopyGeneratedPublicKey,
}: {
  mode: PanelMode
  selected: SSHConnection | null
  draft: SSHDraft
  busy: boolean
  canSave: boolean
  onDraftChange: (patch: Partial<SSHDraft>) => void
  onCreate: () => void
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
  onDelete: () => void
  onConnect: () => void
  privateKeyInputRef: RefObject<HTMLInputElement | null>
  generatedPublicKey: string | null
  onSelectPrivateKeyFile: () => void
  onPrivateKeyFile: (event: ChangeEvent<HTMLInputElement>) => void
  onGeneratePrivateKey: () => void
  onCopyGeneratedPublicKey: () => void
}) {
  const editing = mode === 'create' || mode === 'edit'
  const title = mode === 'create' ? 'New host' : selected?.name ?? 'Host details'

  return (
    <aside className="flex min-h-0 w-full flex-none flex-col border-t border-loom-border bg-loom-surface xl:w-[370px] xl:border-l xl:border-t-0">
      <div className="flex flex-none items-start gap-2 border-b border-loom-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-semibold text-loom-fg">{title}</h2>
          <p className="mt-0.5 font-mono text-[10.5px] text-loom-dim">Loom SSH vault</p>
        </div>
        {editing ? (
          <Button variant="ghost" size="icon-sm" aria-label="Cancel editing" onClick={onCancel} disabled={busy}>
            <X size={14} />
          </Button>
        ) : selected ? (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="Edit host" onClick={onEdit}>
              <Pencil size={14} />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Delete host" onClick={onDelete} className="hover:text-loom-red-soft">
              <Trash2 size={14} />
            </Button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!selected && !editing ? (
          <div className="flex h-full min-h-[220px] flex-col items-center justify-center rounded-[12px] border border-dashed border-loom-border-card bg-loom-bg px-5 text-center">
            <Cable size={24} className="mb-3 text-loom-dim" />
            <div className="text-[13px] font-medium text-loom-fg-2">No host selected</div>
            <p className="mt-1 max-w-[240px] text-[12px] leading-relaxed text-loom-dim">
              Pick a saved host or create a new SSH connection to show its details here.
            </p>
            <Button className="mt-4" size="sm" onClick={onCreate}>
              <Plus size={13} />
              New host
            </Button>
          </div>
        ) : editing ? (
          <div className="space-y-3.5">
            <div className="rounded-[12px] border border-loom-border-card bg-loom-card p-3">
              <div className="mb-3 flex items-center gap-2.5">
                <HostGlyph authType={draft.authType} selected />
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-loom-fg-2">
                    {mode === 'create' ? 'Add SSH host' : 'Edit SSH host'}
                  </div>
                  <div className="font-mono text-[10.5px] text-loom-dim">credentials are write-only</div>
                </div>
              </div>

              <Label>Name</Label>
              <Input
                value={draft.name}
                disabled={busy}
                onChange={(event) => onDraftChange({ name: event.target.value })}
                placeholder="Production master"
                className="mb-3"
              />

              <div className="mb-3 grid grid-cols-[1fr_86px] gap-2.5">
                <div className="min-w-0">
                  <Label>Host</Label>
                  <Input
                    value={draft.host}
                    disabled={busy}
                    onChange={(event) => onDraftChange({ host: event.target.value })}
                    placeholder="172.27.169.106"
                    className="font-mono"
                  />
                </div>
                <div>
                  <Label>Port</Label>
                  <Input
                    value={draft.port}
                    disabled={busy}
                    onChange={(event) => onDraftChange({ port: event.target.value })}
                    placeholder="22"
                    className="font-mono"
                  />
                </div>
              </div>

              <Label>Username</Label>
              <Input
                value={draft.username}
                disabled={busy}
                onChange={(event) => onDraftChange({ username: event.target.value })}
                placeholder="clouduser"
                className="mb-3 font-mono"
              />

              <Label>Auth method</Label>
              <Select
                value={draft.authType}
                onValueChange={(value) => onDraftChange({ authType: value as AuthType })}
                options={AUTH_OPTIONS}
                disabled={busy}
                aria-label="Auth method"
              />
            </div>

            <div className="rounded-[12px] border border-loom-border-card bg-loom-card p-3">
              <div className="mb-3 flex items-center gap-2 text-[12.5px] font-medium text-loom-fg-2">
                <ShieldCheck size={14} className="text-loom-accent-soft" />
                Credentials
              </div>

              {draft.authType === 'password' ? (
                <>
                  <Label>Password</Label>
                  <Input
                    value={draft.password}
                    disabled={busy}
                    type="password"
                    onChange={(event) => onDraftChange({ password: event.target.value })}
                    placeholder={mode === 'edit' ? 'unchanged' : ''}
                    className="font-mono"
                  />
                  <SecretHelp mode={mode} authType={draft.authType} />
                </>
              ) : (
                <>
                  <input
                    ref={privateKeyInputRef}
                    type="file"
                    className="hidden"
                    accept=".pem,.key,.txt,*"
                    onChange={onPrivateKeyFile}
                  />
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <Label className="mb-0">Private key (PEM / ~/.ssh)</Label>
                    <div className="flex items-center gap-1.5">
                      <Button variant="secondary" size="sm" onClick={onSelectPrivateKeyFile} disabled={busy}>
                        Select key
                      </Button>
                      <Button variant="ghost" size="sm" onClick={onGeneratePrivateKey} disabled={busy}>
                        Generate
                      </Button>
                    </div>
                  </div>
                  <Input
                    value={draft.privateKeyPath}
                    disabled={busy || Boolean(draft.privateKey)}
                    onChange={(event) => onDraftChange({ privateKeyPath: event.target.value })}
                    placeholder="~/.ssh/id_ed25519"
                    className="mb-2.5 font-mono"
                  />
                  <textarea
                    value={draft.privateKey}
                    disabled={busy}
                    onChange={(event) => onDraftChange({ privateKey: event.target.value, privateKeyPath: '' })}
                    placeholder={mode === 'edit' ? 'unchanged' : 'select ~/.ssh/id_ed25519, paste PEM, or generate a key'}
                    rows={5}
                    className="w-full resize-y rounded-lg border border-loom-border-strong bg-loom-bg px-2.5 py-2 font-mono text-[11px] text-loom-fg outline-none transition-colors placeholder:text-loom-dim-2 focus-visible:border-loom-border-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                  <SecretHelp mode={mode} authType={draft.authType} />
                  {generatedPublicKey ? (
                    <div className="mt-2.5 rounded-lg border border-loom-border-strong bg-loom-bg p-2.5">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-loom-muted">Generated public key</span>
                        <Button variant="ghost" size="sm" onClick={onCopyGeneratedPublicKey}>
                          Copy
                        </Button>
                      </div>
                      <code className="block break-all font-mono text-[10.5px] leading-relaxed text-loom-fg-2">
                        {generatedPublicKey}
                      </code>
                      <p className="mt-1.5 text-[10.5px] leading-snug text-loom-dim">
                        Add this public key to the host's ~/.ssh/authorized_keys before connecting.
                      </p>
                    </div>
                  ) : null}
                  <Label className="mt-3">Passphrase</Label>
                  <Input
                    value={draft.passphrase}
                    disabled={busy}
                    type="password"
                    onChange={(event) => onDraftChange({ passphrase: event.target.value })}
                    placeholder={mode === 'edit' ? 'unchanged' : 'optional'}
                    className="font-mono"
                  />
                </>
              )}
            </div>
          </div>
        ) : selected ? (
          <div className="space-y-3.5">
            <div className="rounded-[12px] border border-loom-border-card bg-loom-card p-3">
              <div className="mb-3 flex items-center gap-3">
                <HostGlyph authType={selected.authType} selected />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-loom-fg">{selected.name}</div>
                  <div className="truncate font-mono text-[10.5px] text-loom-dim-2">{connectionSubtitle(selected)}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <DetailRow label="Host" value={selected.host} mono />
                <DetailRow label="Port" value={String(selected.port)} mono />
              </div>
              <div className="mt-2.5 grid grid-cols-2 gap-2.5">
                <DetailRow label="User" value={selected.username} mono />
                <DetailRow label="Auth" value={authLabel(selected.authType)} />
              </div>
            </div>

            <div className="rounded-[12px] border border-loom-border-card bg-loom-card p-3">
              <div className="mb-3 flex items-center gap-2 text-[12.5px] font-medium text-loom-fg-2">
                <Fingerprint size={14} className="text-loom-muted" />
                Host key
              </div>
              <div className="rounded-lg border border-loom-border-strong bg-loom-bg px-2.5 py-2">
                <HostKeyBadge connection={selected} />
              </div>
              <p className="mt-2 text-[11px] leading-snug text-loom-dim">
                Empty keys pin on first successful connection. Reset only after verifying the host changed.
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-none items-center gap-2 border-t border-loom-border p-4">
        {editing ? (
          <>
            <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={onSave} disabled={!canSave || busy}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              {mode === 'create' ? 'Add host' : 'Save host'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onCreate} className="flex-1">
              <Plus size={13} />
              New
            </Button>
            <Button onClick={onConnect} disabled={!selected} className="flex-[1.4]">
              <TerminalSquare size={14} />
              Connect
            </Button>
          </>
        )}
      </div>
    </aside>
  )
}

export function SSHConnectionsModule() {
  const navigate = useNavigate()
  const { wsId } = useScope()
  const { data: connections, isLoading, error, refetch } = useSSHConnections()
  const createConnection = useCreateSSHConnection()
  const updateConnection = useUpdateSSHConnection()
  const openSSHShellTab = useLoomStore((s) => s.openSSHShellTab)
  const askDelete = useLoomStore((s) => s.askDelete)
  const showToast = useLoomStore((s) => s.showToast)

  const hosts = useMemo(() => connections ?? [], [connections])
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pendingSelectedId, setPendingSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<PanelMode>('view')
  const [draft, setDraft] = useState<SSHDraft>(EMPTY_DRAFT)
  const [generatedPublicKey, setGeneratedPublicKey] = useState<string | null>(null)
  const privateKeyInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (mode === 'create' || !selectedId) return
    if (hosts.some((connection) => connection.id === selectedId)) {
      if (pendingSelectedId === selectedId) setPendingSelectedId(null)
      return
    }
    if (pendingSelectedId === selectedId) return
    setSelectedId(null)
    setPendingSelectedId(null)
    setMode('view')
  }, [hosts, mode, pendingSelectedId, selectedId])

  const selected = hosts.find((connection) => connection.id === selectedId) ?? null
  const query = search.trim().toLowerCase()
  const filtered = useMemo(
    () => (query ? hosts.filter((connection) => hostSearchText(connection).includes(query)) : hosts),
    [hosts, query],
  )
  const privateKeyCount = hosts.filter((connection) => connection.authType === 'privatekey').length
  const passwordCount = hosts.length - privateKeyCount
  const pinnedCount = hosts.filter((connection) => connection.hostKeyFingerprint).length
  const busy = createConnection.isPending || updateConnection.isPending
  const canSave = draftIsValid(draft, mode) && !busy

  function startCreate() {
    setDraft(EMPTY_DRAFT)
    setGeneratedPublicKey(null)
    setSelectedId(null)
    setPendingSelectedId(null)
    setMode('create')
  }

  function startEdit() {
    if (!selected) return
    setDraft(draftFromConnection(selected))
    setGeneratedPublicKey(null)
    setMode('edit')
  }

  function cancelEdit() {
    setPendingSelectedId(null)
    setGeneratedPublicKey(null)
    setMode('view')
    setDraft(EMPTY_DRAFT)
  }

  function selectConnection(connection: SSHConnection) {
    setSelectedId(connection.id)
    setPendingSelectedId(null)
    setGeneratedPublicKey(null)
    setDraft(EMPTY_DRAFT)
    setMode('view')
  }

  function updateDraft(patch: Partial<SSHDraft>) {
    if ('privateKey' in patch || 'privateKeyPath' in patch || patch.authType === 'password') setGeneratedPublicKey(null)
    setDraft((current) => ({
      ...current,
      ...(patch.authType === 'privatekey' && !current.privateKeyPath && !current.privateKey ? { privateKeyPath: '~/.ssh/id_ed25519' } : {}),
      ...patch,
    }))
  }

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
      setDraft((current) => ({ ...current, authType: 'privatekey', privateKey: text, privateKeyPath: '' }))
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
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 3072,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )
      const [privateDer, publicJwk] = await Promise.all([
        crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
        crypto.subtle.exportKey('jwk', keyPair.publicKey),
      ])
      const privateKey = pemBlock('PRIVATE KEY', privateDer)
      const publicKey = sshRsaPublicKey(publicJwk)
      setDraft((current) => ({ ...current, authType: 'privatekey', privateKey, privateKeyPath: '' }))
      setGeneratedPublicKey(publicKey)
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

  function saveDraft() {
    const port = parsePort(draft.port)
    if (!port) return

    const base = {
      name: draft.name.trim(),
      host: draft.host.trim(),
      port,
      username: draft.username.trim(),
      authType: draft.authType,
    }
    const secrets: UpdateSSHConnectionBody = {}
    if (draft.password) secrets.password = draft.password
    if (draft.privateKey) secrets.privateKey = draft.privateKey
    else if (draft.privateKeyPath) secrets.privateKeyPath = draft.privateKeyPath
    if (draft.passphrase) secrets.passphrase = draft.passphrase

    if (mode === 'edit' && selected) {
      updateConnection.mutate(
        { id: selected.id, patch: { ...base, ...secrets } },
        {
          onSuccess: (saved) => {
            setSelectedId(saved.id)
            setPendingSelectedId(null)
            setDraft(EMPTY_DRAFT)
            setGeneratedPublicKey(null)
            setMode('view')
            showToast(`Updated SSH connection "${saved.name}"`)
          },
          onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to update SSH connection'),
        },
      )
      return
    }

    if (mode === 'create') {
      createConnection.mutate(
        { ...base, ...secrets } satisfies CreateSSHConnectionBody,
        {
          onSuccess: (saved) => {
            setSelectedId(saved.id)
            setPendingSelectedId(saved.id)
            setDraft(EMPTY_DRAFT)
            setGeneratedPublicKey(null)
            setMode('view')
            showToast(`Added SSH connection "${saved.name}"`)
          },
          onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to add SSH connection'),
        },
      )
    }
  }

  function deleteSelected() {
    if (!selected) return
    askDelete('ssh', selected.id, selected.name)
  }

  function connectSelected() {
    if (!selected || !wsId) return
    openSSHShellTab(wsId, selected.id)
    navigate({ to: '/w/$wsId', params: { wsId } })
  }

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <DataLoading compact label="loading connections…" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        <div className="flex w-full max-w-[420px] flex-col items-center rounded-[12px] border border-loom-border-card bg-loom-card px-5 py-6 text-center">
          <Cable size={24} className="mb-3 text-loom-dim" />
          <div className="text-[13px] font-medium text-loom-fg-2">Could not load SSH hosts</div>
          <p className="mt-1 text-[12px] leading-relaxed text-loom-dim">
            {error instanceof Error ? error.message : 'Failed to load SSH connections'}
          </p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-loom-bg xl:flex-row">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-none items-center gap-2 border-b border-loom-border bg-loom-surface px-3 py-2.5">
          <div className="relative min-w-0 flex-1">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-loom-dim" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a host or ssh user@hostname…"
              className="h-8 bg-loom-card pl-8 font-mono text-[12px]"
            />
          </div>
          <Button onClick={startCreate} size="sm">
            <Plus size={13} />
            New host
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          <div className="mb-6">
            <div className="mb-2.5 text-[12px] font-semibold text-loom-fg-2">Groups</div>
            <div className="flex flex-wrap gap-2.5">
              <GroupCard label="All hosts" count={hosts.length} icon={<Cable size={15} />} />
              <GroupCard label="Password" count={passwordCount} icon={<Server size={15} />} />
              <GroupCard label="Private key" count={privateKeyCount} icon={<KeyRound size={15} />} />
              <GroupCard label="Pinned keys" count={pinnedCount} icon={<Fingerprint size={15} />} />
            </div>
          </div>

          <div className="mb-2.5 flex items-center gap-2">
            <div className="text-[12px] font-semibold text-loom-fg-2">Hosts</div>
            <span className="font-mono text-[10.5px] text-loom-dim">
              {filtered.length} of {hosts.length}
            </span>
          </div>

          {hosts.length === 0 ? (
            <div className="flex min-h-[260px] flex-col items-center justify-center rounded-[12px] border border-dashed border-loom-border-card bg-loom-card px-5 text-center">
              <Cable size={26} className="mb-3 text-loom-dim" />
              <div className="text-[13px] font-medium text-loom-fg-2">No SSH hosts yet</div>
              <p className="mt-1 max-w-[330px] text-[12px] leading-relaxed text-loom-dim">
                Add any reachable SSH host. Loom stores credentials encrypted and opens it as a workspace shell tab.
              </p>
              <Button className="mt-4" size="sm" onClick={startCreate}>
                <Plus size={13} />
                Add first host
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-[180px] items-center justify-center rounded-[12px] border border-loom-border-card bg-loom-card font-mono text-[12px] text-loom-dim">
              No hosts match “{search.trim()}”
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-2.5 pb-4">
              {filtered.map((connection) => (
                <HostCard
                  key={connection.id}
                  connection={connection}
                  selected={mode !== 'create' && selectedId === connection.id}
                  onSelect={() => selectConnection(connection)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {mode !== 'view' || selected ? (
        <HostDetailsPanel
          mode={mode}
          selected={selected}
          draft={draft}
          busy={busy}
          canSave={canSave}
          onDraftChange={updateDraft}
          onCreate={startCreate}
          onEdit={startEdit}
          onCancel={cancelEdit}
          onSave={saveDraft}
          onDelete={deleteSelected}
          onConnect={connectSelected}
          privateKeyInputRef={privateKeyInputRef}
          generatedPublicKey={generatedPublicKey}
          onSelectPrivateKeyFile={selectPrivateKeyFile}
          onPrivateKeyFile={handlePrivateKeyFile}
          onGeneratePrivateKey={generatePrivateKey}
          onCopyGeneratedPublicKey={copyGeneratedPublicKey}
        />
      ) : null}
    </div>
  )
}
