import { useEffect, useState } from 'react'
import { KeyRound, LockKeyhole, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  useCreateAgentEnvProfile,
  useFetchAgentEnvModels,
  useUpdateAgentEnvProfile,
} from '@/features/data/queries'
import type { EnvProfileInput, EnvProfilePatch } from '@/lib/machineApi'
import type { EnvProfileSummary, Machine } from '@/store/types'
import { cn } from '@/lib/utils'

const CLAUDE_SLOTS = [
  { slot: 'opus', label: 'Opus', envKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL' },
  { slot: 'sonnet', label: 'Sonnet', envKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL' },
  { slot: 'haiku', label: 'Haiku', envKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' },
] as const

const DEFAULT_ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
]

interface CustomRow {
  key: string
  value: string
}

function rowsFromExtra(extra: Record<string, string>): CustomRow[] {
  return Object.entries(extra)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }))
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function EnvProfileDialog({
  open,
  machine,
  agentId,
  profile,
  onOpenChange,
}: {
  open: boolean
  machine: Machine
  agentId: string
  /** null = create mode; a summary = edit mode. */
  profile: EnvProfileSummary | null
  onOpenChange: (open: boolean) => void
}) {
  const isCodex = agentId === 'codex'
  const isEdit = profile !== null
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [authToken, setAuthToken] = useState('')
  const [models, setModels] = useState<Record<string, string>>({})
  const [rows, setRows] = useState<CustomRow[]>([])
  const [fetched, setFetched] = useState<string[]>([])
  const [error, setError] = useState('')

  // Codex-specific fields
  const [codexProviderName, setCodexProviderName] = useState('')
  const [codexWireAPI, setCodexWireAPI] = useState('chat')
  const [codexEnvKey, setCodexEnvKey] = useState('OPENAI_API_KEY')
  const [codexContextWindow, setCodexContextWindow] = useState('')
  const [codexMaxTokens, setCodexMaxTokens] = useState('')

  const createProfile = useCreateAgentEnvProfile()
  const updateProfile = useUpdateAgentEnvProfile()
  const fetchModels = useFetchAgentEnvModels()

  useEffect(() => {
    if (!open) return
    if (profile) {
      setName(profile.name)
      setBaseUrl(profile.baseUrl)
      setModels({ ...profile.models })
      setRows(rowsFromExtra(profile.extraEnv))
      setCodexProviderName(profile.codexProviderName ?? '')
      setCodexWireAPI(profile.codexWireAPI ?? 'chat')
      setCodexEnvKey(profile.codexEnvKey ?? 'OPENAI_API_KEY')
      setCodexContextWindow(profile.codexContextWindow ? String(profile.codexContextWindow) : '')
      setCodexMaxTokens(profile.codexMaxTokens ? String(profile.codexMaxTokens) : '')
    } else {
      setName('')
      setBaseUrl('')
      setModels({})
      setRows([])
      setCodexProviderName('')
      setCodexWireAPI('chat')
      setCodexEnvKey('OPENAI_API_KEY')
      setCodexContextWindow('')
      setCodexMaxTokens('')
    }
    setAuthToken('')
    setFetched([])
    setError('')
  }, [open, profile])

  const busy = createProfile.isPending || updateProfile.isPending

  function updateRow(index: number, patch: Partial<CustomRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function addRow() {
    setRows((current) => [...current, { key: '', value: '' }])
  }

  function removeRow(index: number) {
    setRows((current) => current.filter((_, i) => i !== index))
  }

  async function runFetchModels() {
    const url = baseUrl.trim()
    if (!isValidHttpUrl(url)) {
      setError('Enter a valid http(s) base URL before fetching models.')
      return
    }
    setError('')
    try {
      const result = await fetchModels.mutateAsync({
        machine,
        agentId,
        body: {
          baseUrl: url,
          authToken: authToken.trim() || undefined,
          profileId: isEdit && !authToken.trim() ? profile?.id : undefined,
        },
      })
      const ids = result.map((m) => m.id)
      setFetched(ids)
      if (ids.length === 0) {
        toast.message('Provider returned no models')
      } else {
        toast.success(`Loaded ${ids.length} model${ids.length === 1 ? '' : 's'}`)
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Could not fetch models')
    }
  }

  async function submit() {
    const cleanName = name.trim()
    const cleanUrl = baseUrl.trim()
    if (!cleanName) {
      setError('Name is required.')
      return
    }
    if (!isValidHttpUrl(cleanUrl)) {
      setError('Base URL must be a valid http(s) URL.')
      return
    }
    if (!isEdit && !authToken.trim()) {
      setError('Auth token is required to create a profile.')
      return
    }

    const extraEnv: Record<string, string> = {}
    for (const row of rows) {
      const key = row.key.trim()
      if (!key) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        setError(`"${key}" is not a valid environment key.`)
        return
      }
      extraEnv[key] = row.value
    }

    setError('')
    try {
      const common = {
        name: cleanName,
        baseUrl: cleanUrl,
        models,
        extraEnv,
        codexProviderName: isCodex ? codexProviderName.trim() : undefined,
        codexWireAPI: isCodex ? codexWireAPI : undefined,
        codexEnvKey: isCodex ? codexEnvKey.trim() || undefined : undefined,
        codexContextWindow: isCodex && codexContextWindow ? parseInt(codexContextWindow, 10) || 0 : undefined,
        codexMaxTokens: isCodex && codexMaxTokens ? parseInt(codexMaxTokens, 10) || 0 : undefined,
      }
      if (isEdit && profile) {
        const token = authToken.trim()
        await updateProfile.mutateAsync({
          machine,
          agentId,
          profileId: profile.id,
          body: { ...common, authToken: token || undefined } as EnvProfilePatch,
        })
        toast.success(`${cleanName} updated`)
      } else {
        await createProfile.mutateAsync({
          machine,
          agentId,
          body: { ...common, authToken: authToken.trim() } as EnvProfileInput,
        })
        toast.success(`${cleanName} saved`)
      }
      onOpenChange(false)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not save profile')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={640}
      className="max-h-[calc(100dvh-24px)] overflow-y-auto p-5 sm:p-6"
    >
      {/* ── header ── */}
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-devdeck-border-accent bg-devdeck-accent-tint text-devdeck-accent-soft">
          <KeyRound size={18} />
        </div>
        <div>
          <DialogTitle>{isEdit ? 'Edit environment' : 'Add LLM environment'}</DialogTitle>
          <DialogDescription className="mt-1 leading-relaxed">
            {isCodex
              ? 'A Codex provider profile. Activating one writes to '
              : 'A Claude Code provider profile. Activating one writes its '}
            {isCodex ? (
              <><span className="font-mono">config.toml</span> + <span className="font-mono">auth.json</span>.</>
            ) : (
              <><span className="font-mono">env</span> block into <span className="font-mono">~/.claude/settings.json</span>.</>
            )}
          </DialogDescription>
        </div>
      </div>

      {/* ── form body ── */}
      <div className="mt-6 grid gap-5">
        {/* name + base URL */}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="text-[11.5px] font-medium text-devdeck-muted">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={isCodex ? 'My Codex Profile' : 'GLM Provider'}
              autoComplete="off"
              className="h-9 text-[12.5px]"
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-[11.5px] font-medium text-devdeck-muted">Base URL</span>
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com"
              autoComplete="off"
              spellCheck={false}
              className="h-9 text-[12.5px] font-mono"
            />
          </label>
        </div>

        {/* auth token */}
        <label className="grid gap-1.5">
          <span className="text-[11.5px] font-medium text-devdeck-muted">
            {isCodex ? 'API key' : 'Auth token'}
          </span>
          <Input
            type="password"
            value={authToken}
            onChange={(event) => setAuthToken(event.target.value)}
            placeholder={
              isEdit && profile?.hasToken
                ? 'Keep stored key (leave blank)'
                : isCodex
                  ? 'sk-...'
                  : 'sk-...'
            }
            autoComplete="off"
            spellCheck={false}
            className="h-9 text-[12.5px] font-mono"
          />
          <span className="font-mono text-[9.5px] text-devdeck-dim">
            {isEdit
              ? 'Leave blank to keep the stored value unchanged.'
              : 'Required to create a profile.'}
          </span>
        </label>

        {/* ── Codex-specific provider fields ── */}
        {isCodex ? (
          <fieldset className="rounded-xl border border-devdeck-border-card bg-devdeck-surface-2 p-4">
            <legend className="mb-3 text-[11.5px] font-medium text-devdeck-muted-2">
              Provider config
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-devdeck-dim">
                  Provider name
                </span>
                <Input
                  value={codexProviderName}
                  onChange={(e) => setCodexProviderName(e.target.value)}
                  placeholder="OpenAI"
                  autoComplete="off"
                  className="h-8 text-[11px]"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-devdeck-dim">
                  Wire API
                </span>
                <select
                  value={codexWireAPI}
                  onChange={(e) => setCodexWireAPI(e.target.value)}
                  className="h-8 rounded-lg border border-devdeck-border-card bg-devdeck-bg px-2 text-[11px] font-mono text-devdeck-fg focus:outline-none focus:ring-2 focus:ring-ring/50"
                >
                  <option value="chat">chat</option>
                  <option value="responses">responses</option>
                </select>
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-devdeck-dim">
                  Env key
                </span>
                <Input
                  value={codexEnvKey}
                  onChange={(e) => setCodexEnvKey(e.target.value)}
                  placeholder="OPENAI_API_KEY"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 text-[11px] font-mono"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-devdeck-dim">
                  Model
                </span>
                <Input
                  value={models['model'] ?? ''}
                  onChange={(e) =>
                    setModels((m) => ({ ...m, model: e.target.value }))
                  }
                  placeholder="qwen3.5-coder-32b"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 text-[11px] font-mono"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-devdeck-dim">
                  Context window
                </span>
                <Input
                  type="number"
                  value={codexContextWindow}
                  onChange={(e) => setCodexContextWindow(e.target.value)}
                  placeholder="32000"
                  autoComplete="off"
                  className="h-8 text-[11px] font-mono"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-devdeck-dim">
                  Max output tokens
                </span>
                <Input
                  type="number"
                  value={codexMaxTokens}
                  onChange={(e) => setCodexMaxTokens(e.target.value)}
                  placeholder="4000"
                  autoComplete="off"
                  className="h-8 text-[11px] font-mono"
                />
              </label>
            </div>
          </fieldset>
        ) : (
          <>
            {/* ── model slots + fetch (Claude) ── */}
            <fieldset className="rounded-xl border border-devdeck-border-card bg-devdeck-surface-2 p-4">
              <div className="mb-3 flex items-center justify-between">
                <legend className="text-[11.5px] font-medium text-devdeck-muted-2">Model slots</legend>
                <button
                  type="button"
                  onClick={() => void runFetchModels()}
                  disabled={fetchModels.isPending}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-devdeck-border-card bg-devdeck-bg px-2.5 font-mono text-[10px] text-devdeck-muted-2 transition-colors hover:border-devdeck-border-strong hover:text-devdeck-fg disabled:opacity-55"
                >
                  <RefreshCw size={11} className={cn(fetchModels.isPending && 'animate-spin')} />
                  Fetch models
                </button>
              </div>
              <datalist id="env-profile-models">
                {fetched.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <div className="grid gap-3 sm:grid-cols-3">
                {CLAUDE_SLOTS.map((slot) => (
                  <label key={slot.slot} className="grid gap-1">
                    <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-devdeck-dim">
                      {slot.label}
                    </span>
                    <Input
                      list="env-profile-models"
                      value={models[slot.slot] ?? ''}
                      onChange={(event) =>
                        setModels((current) => ({ ...current, [slot.slot]: event.target.value }))
                      }
                      placeholder="glm-4.5"
                      autoComplete="off"
                      spellCheck={false}
                      className="h-8 text-[11px] font-mono"
                    />
                  </label>
                ))}
              </div>
              {fetched.length > 0 ? (
                <p className="mt-2 text-[9.5px] text-devdeck-dim">
                  {fetched.length} model{fetched.length === 1 ? '' : 's'} available — pick from the list or
                  type your own.
                </p>
              ) : null}
            </fieldset>

            {/* ── default env keys (Claude only) ── */}
            <div className="rounded-xl border border-devdeck-border-card px-4 py-3">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-devdeck-muted-2">
                <LockKeyhole size={12} className="text-devdeck-dim" />
                Default keys (always written, non-deletable)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {DEFAULT_ENV_KEYS.map((key) => (
                  <span
                    key={key}
                    className="rounded-md border border-devdeck-border-card bg-devdeck-surface-2 px-1.5 py-1 font-mono text-[9px] leading-none text-devdeck-muted-2"
                  >
                    {key}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── custom env keys ── */}
        <fieldset>
          <legend className="mb-2.5 text-[11.5px] font-medium text-devdeck-muted">Custom env keys</legend>
          <div className="grid gap-2">
            {rows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-devdeck-border px-3 py-3 text-center text-[11px] text-devdeck-dim">
                No custom keys yet.
              </div>
            ) : (
              rows.map((row, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_32px] items-center gap-2"
                >
                  <Input
                    value={row.key}
                    onChange={(event) => updateRow(index, { key: event.target.value })}
                    placeholder="EXTRA_KEY"
                    autoComplete="off"
                    spellCheck={false}
                    className="h-8 text-[11px] font-mono"
                  />
                  <Input
                    value={row.value}
                    onChange={(event) => updateRow(index, { value: event.target.value })}
                    placeholder="value"
                    autoComplete="off"
                    spellCheck={false}
                    className="h-8 text-[11px] font-mono"
                  />
                  <button
                    type="button"
                    aria-label="Remove key"
                    onClick={() => removeRow(index)}
                    className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-devdeck-dim transition-colors hover:bg-devdeck-red-tint-hover hover:text-devdeck-red-soft"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
          <button
            type="button"
            onClick={addRow}
            className="mt-2.5 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-devdeck-border-card bg-devdeck-surface-2 px-2.5 text-[11px] text-devdeck-muted transition-colors hover:border-devdeck-border-strong hover:text-devdeck-fg"
          >
            <Plus size={12} />
            Add key
          </button>
        </fieldset>

        {/* ── error ── */}
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint-hover px-3 py-2 text-[11px] text-devdeck-red-soft"
          >
            {error}
          </div>
        ) : null}
      </div>

      {/* ── footer ── */}
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <DialogClose
          render={<Button variant="secondary" className="w-full sm:w-auto" disabled={busy} />}
        >
          Cancel
        </DialogClose>
        <Button className="w-full sm:w-auto" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving...' : isEdit ? 'Save changes' : 'Add environment'}
        </Button>
      </div>
    </Dialog>
  )
}
