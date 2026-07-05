import { useMemo, useState } from 'react'
import {
  CircleAlert,
  Code,
  EllipsisVertical,
  Globe,
  LayoutList,
  Layers,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
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
  useActivateAgentEnvProfile,
  useDeactivateAgentEnvProfile,
  useRemoveAgentEnvProfile,
} from '@/features/data/queries'
import type { EnvProfileSummary } from '@/store/types'
import type { AgentSummary } from '@/store/types'
import { cn } from '@/lib/utils'
import { AgentMark } from './AgentMark'
import { EnvProfileDialog } from './EnvProfileDialog'
import { EnvSettingsEditor } from './EnvSettingsEditor'

const SLOTS = [
  { slot: 'opus', label: 'opus' },
  { slot: 'sonnet', label: 'sonnet' },
  { slot: 'haiku', label: 'haiku' },
] as const

type InnerTab = 'profiles' | 'editor'

interface PendingRemoval {
  profile: EnvProfileSummary
}

export function EnvProfileManagement({
  agentId,
  allSettingsAgents,
  profiles,
  loading,
  onSelectAgent,
}: {
  agentId: string
  allSettingsAgents: AgentSummary[]
  profiles: EnvProfileSummary[]
  loading: boolean
  onSelectAgent: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<EnvProfileSummary | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null)
  const [innerTab, setInnerTab] = useState<InnerTab>('profiles')
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [envExpanded, setEnvExpanded] = useState(false)
  const activate = useActivateAgentEnvProfile()
  const deactivate = useDeactivateAgentEnvProfile()
  const remove = useRemoveAgentEnvProfile()

  const activeProfile = useMemo(() => profiles.find((p) => p.active) ?? null, [profiles])
  const activeEnv = useMemo(() => {
    if (!activeProfile) return null
    const env: Record<string, string> = {
      ANTHROPIC_AUTH_TOKEN: activeProfile.hasToken ? '••••••••' : '',
      ANTHROPIC_BASE_URL: activeProfile.baseUrl,
    }
    for (const slot of SLOTS) {
      const v = activeProfile.models[slot.slot]
      if (v) {
        env[`ANTHROPIC_DEFAULT_${slot.label.toUpperCase()}_MODEL`] = v
        env[`ANTHROPIC_DEFAULT_${slot.label.toUpperCase()}_MODEL_NAME`] = v
      }
    }
    for (const [k, v] of Object.entries(activeProfile.extraEnv)) {
      env[k] = v
    }
    return env
  }, [activeProfile])
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase()
    const sorted = [...profiles].sort(
      (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name),
    )
    if (!search) return sorted
    return sorted.filter(
      (p) =>
        p.name.toLowerCase().includes(search) ||
        p.baseUrl.toLowerCase().includes(search) ||
        p.id.toLowerCase().includes(search),
    )
  }, [profiles, query])

  function openCreate() {
    setEditing(null)
    setDialogOpen(true)
  }
  function openEdit(profile: EnvProfileSummary) {
    setEditing(profile)
    setDialogOpen(true)
  }

  async function toggleActive(profile: EnvProfileSummary) {
    try {
      if (profile.active) {
        await deactivate.mutateAsync(agentId)
        toast.success(`${profile.name} deactivated`)
      } else {
        await activate.mutateAsync({ agentId, profileId: profile.id })
        toast.success(`${profile.name} is now active`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not change active profile')
    }
  }

  async function confirmRemoval() {
    if (!pendingRemoval) return
    try {
      await remove.mutateAsync({ agentId, profileId: pendingRemoval.profile.id })
      toast.success(`${pendingRemoval.profile.name} removed`)
      setPendingRemoval(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove profile')
    }
  }

  const currentAgent = allSettingsAgents.find((a) => a.id === agentId)

  return (
    <div className="flex flex-none flex-col md:min-h-0 md:flex-1">
      {/* ── stat header ── */}
      <div className="grid flex-none grid-cols-2 border-b border-loom-border bg-loom-surface/15 md:grid-cols-[minmax(260px,1.2fr)_140px_140px]">
        {/* description + agent switcher */}
        <div className="col-span-2 flex flex-col border-b border-loom-border px-4 pb-3 pt-3 md:col-span-1 md:border-b-0 md:border-r md:pb-0">
          <div className="flex items-center gap-2.5">
            <SlidersHorizontal size={16} className="text-loom-accent-soft" />
            <h2 className="text-[15px] font-semibold tracking-[-0.015em] text-loom-fg">
              LLM environments
            </h2>
          </div>
          <p className="mt-1.5 max-w-[48ch] text-[11.5px] leading-relaxed text-loom-muted-2">
            Save provider profiles and switch the live one. Activating writes the{' '}
            <span className="font-mono">env</span> block into settings.json.
          </p>

          {/* agent switcher pills */}
          {allSettingsAgents.length > 1 ? (
            <div className="mt-5 mb-5 flex gap-1.5" role="radiogroup" aria-label="Select agent">
              {allSettingsAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  role="radio"
                  aria-checked={agent.id === agentId}
                  onClick={() => onSelectAgent(agent.id)}
                  className={cn(
                    'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    agent.id === agentId
                      ? 'border-loom-border-accent bg-loom-accent-tint text-loom-fg shadow-xs'
                      : 'border-loom-border-card text-loom-muted hover:border-loom-border-strong hover:bg-loom-hover-wash hover:text-loom-fg',
                  )}
                >
                  <AgentMark id={agent.id} name={agent.name} active={agent.id === agentId} size="sm" />
                  {agent.name}
                </button>
              ))}
            </div>
          ) : currentAgent ? (
            <div className="mt-2.5 flex items-center gap-2">
              <AgentMark id={currentAgent.id} name={currentAgent.name} size="sm" />
              <span className="text-[11px] font-medium text-loom-muted-2">{currentAgent.name}</span>
            </div>
          ) : null}
        </div>

        {/* profiles count */}
        <div className="flex flex-col justify-center border-r border-loom-border px-4 py-3">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-loom-dim">
            Profiles
          </span>
          <span className="mt-0.5 font-mono text-[22px] font-semibold leading-none tracking-tight text-loom-fg">
            {profiles.length}
          </span>
        </div>

        {/* active count */}
        <div className="flex flex-col justify-center px-4 py-3">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-loom-dim">
            Active
          </span>
          <span
            className={cn(
              'mt-0.5 font-mono text-[22px] font-semibold leading-none tracking-tight',
              activeProfile ? 'text-loom-accent-soft' : 'text-loom-dim',
            )}
          >
            {activeProfile ? 1 : 0}
          </span>
        </div>
      </div>

      {/* ── inner tabs ── */}
      <div
        className="flex flex-none gap-1 border-b border-loom-border bg-loom-bg px-4 py-2"
        role="tablist"
        aria-label="Settings views"
      >
        <button
          type="button"
          role="tab"
          aria-selected={innerTab === 'profiles'}
          onClick={() => setInnerTab('profiles')}
          className={cn(
            'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            innerTab === 'profiles'
              ? 'border border-loom-border-accent bg-loom-accent-tint text-loom-fg'
              : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
          )}
        >
          <Layers size={13} />
          Profiles
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={innerTab === 'editor'}
          onClick={() => setInnerTab('editor')}
          className={cn(
            'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            innerTab === 'editor'
              ? 'border border-loom-border-accent bg-loom-accent-tint text-loom-fg'
              : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
          )}
        >
          <Code size={13} />
          Settings file
        </button>
      </div>

      {innerTab === 'profiles' ? (
        <>
          {/* ── active env collapsible list ── */}
          {activeEnv ? (
            <div className="flex-none border-b border-loom-border bg-loom-surface/10">
              <button
                type="button"
                onClick={() => setEnvExpanded(!envExpanded)}
                className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-[11px] font-medium text-loom-muted-2 transition-colors hover:text-loom-fg"
              >
                <svg
                  viewBox="0 0 12 12"
                  fill="none"
                  className={cn('h-3 w-3 flex-none transition-transform', envExpanded && 'rotate-90')}
                >
                  <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <Power size={11} className="text-loom-accent-soft" />
                {activeProfile?.agentId === 'codex' ? 'Active config' : 'Active environment variables'}
                <span className="font-mono text-[9px] text-loom-dim">{Object.keys(activeEnv).length} keys</span>
              </button>
              {envExpanded ? (
                <div className="grid gap-px border-t border-loom-border bg-loom-border">
                  {Object.entries(activeEnv).map(([key, value]) => (
                    <div
                      key={key}
                      className="grid grid-cols-[1fr_1.5fr] gap-3 bg-loom-bg px-4 py-1.5 font-mono text-[10px] leading-relaxed"
                    >
                      <span className="truncate text-loom-dim">{key}</span>
                      <span className="truncate text-loom-fg">{value}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ── search + add toolbar ── */}
          <div className="flex flex-none flex-col gap-2.5 border-b border-loom-border px-4 py-3 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1 sm:max-w-[380px]">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-loom-dim"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search environments..."
                aria-label="Search environments"
                className="h-8 pl-9 text-[12px]"
              />
            </div>
            <div className="hidden sm:block sm:flex-1" />
            <Button className="h-8 w-full text-[12px] sm:w-auto" onClick={openCreate}>
              <Plus size={14} />
              Add environment
            </Button>
          </div>

          {/* ── profile list ── */}
          <div className="flex-none overflow-visible p-4 md:min-h-0 md:flex-1 md:overflow-auto">
            {loading && profiles.length === 0 ? (
              <ProfileListSkeleton />
            ) : filtered.length === 0 && query ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center rounded-xl border border-dashed border-loom-border-strong text-center">
                <Search size={24} strokeWidth={1.5} className="text-loom-dim-2" />
                <p className="mt-3 text-[12.5px] font-medium text-loom-muted">
                  No environments match this search
                </p>
                <button
                  type="button"
                  className="mt-2 cursor-pointer text-[11px] text-loom-accent-soft hover:underline"
                  onClick={() => setQuery('')}
                >
                  Clear search
                </button>
              </div>
            ) : profiles.length === 0 ? (
              <div className="flex min-h-[340px] flex-col items-center justify-center rounded-xl border border-dashed border-loom-border-strong text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-loom-border-card bg-loom-surface-2 text-loom-dim-2">
                  <SlidersHorizontal size={18} strokeWidth={1.5} />
                </div>
                <p className="mt-3 text-[13px] font-medium text-loom-muted">No LLM environments saved</p>
                <p className="mt-1.5 max-w-[44ch] text-[11.5px] leading-relaxed text-loom-dim">
                  Add a provider profile with its base URL, token, and model{agentId === 'codex' ? '' : ' slots'}.
                  Activating one writes the config to the agent&apos;s{agentId === 'codex' ? ' config.toml + auth.json' : ' settings.json'}.
                </p>
                <Button className="mt-5" onClick={openCreate}>
                  <Plus size={14} />
                  Add environment
                </Button>
              </div>
            ) : (
              <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-2.5">
                {filtered.map((profile) => (
                  <article
                    key={profile.id}
                    className={cn(
                      'group relative overflow-hidden rounded-xl border bg-loom-card transition-all',
                      profile.active
                        ? 'border-loom-border-accent shadow-[inset_0_0_0_1px_rgba(var(--loom-accent)/.25)]'
                        : 'border-loom-border-card hover:border-loom-border-strong hover:shadow-sm',
                    )}
                  >
                    {profile.active ? (
                      <div className="absolute left-0 top-0 h-full w-0.5 bg-loom-accent" />
                    ) : null}

                    <div className="flex flex-col gap-0 sm:flex-row sm:items-stretch">
                      <div className="flex min-w-0 flex-1 items-start gap-3 px-3.5 py-3 sm:px-4 sm:py-3.5">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={profile.active}
                          aria-label={profile.active ? `${profile.name} is active` : `Activate ${profile.name}`}
                          title={profile.active ? 'Active — click to clear' : 'Activate this environment'}
                          onClick={() => void toggleActive(profile)}
                          disabled={activate.isPending || deactivate.isPending}
                          className={cn(
                            'mt-0.5 flex h-[18px] w-[18px] flex-none cursor-pointer items-center justify-center rounded-full border-2 transition-all',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                            profile.active
                              ? 'border-loom-accent bg-loom-accent text-loom-bg shadow-xs'
                              : 'border-loom-border-strong text-transparent hover:border-loom-accent',
                          )}
                        >
                          <span className="h-[7px] w-[7px] rounded-full bg-current" />
                        </button>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3
                              className={cn(
                                'truncate text-[13px] font-semibold',
                                profile.active ? 'text-loom-accent-soft' : 'text-loom-fg',
                              )}
                            >
                              {profile.name}
                            </h3>

                            {profile.active ? (
                              <span className="inline-flex items-center gap-1 rounded-md border border-loom-border-accent bg-loom-accent-tint px-1.5 py-0.5 text-[9.5px] font-medium text-loom-accent-soft">
                                <Power size={9} />
                                Active
                              </span>
                            ) : null}

                            {profile.hasToken ? null : (
                              <span className="inline-flex items-center gap-1 rounded-md border border-loom-yellow-tint-border bg-loom-yellow-tint px-1.5 py-0.5 text-[9.5px] text-loom-yellow-tint-text">
                                <CircleAlert size={9} />
                                No token
                              </span>
                            )}
                          </div>

                          <div className="mt-1.5 flex items-center gap-1.5">
                            <Globe size={10} className="flex-none text-loom-dim" />
                            <span className="truncate font-mono text-[10px] text-loom-dim">
                              {profile.baseUrl || '— no base url —'}
                            </span>
                          </div>

                          <div className="mt-2 flex flex-wrap gap-1">
                            {profile.agentId === 'codex' ? (
                              <>
                                {profile.models['model'] ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-loom-border-card bg-loom-surface-2 px-1.5 py-[3px] font-mono text-[9px] leading-none text-loom-muted-2">
                                    <span className="text-[8px] uppercase tracking-[0.06em] text-loom-dim">model</span>
                                    {profile.models['model']}
                                  </span>
                                ) : null}
                                {profile.codexProviderName ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-loom-border-card bg-loom-surface-2 px-1.5 py-[3px] font-mono text-[9px] leading-none text-loom-muted-2">
                                    <span className="text-[8px] uppercase tracking-[0.06em] text-loom-dim">provider</span>
                                    {profile.codexProviderName}
                                  </span>
                                ) : null}
                                {profile.codexWireAPI ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-loom-border-card bg-loom-surface-2 px-1.5 py-[3px] font-mono text-[9px] leading-none text-loom-dim-2">
                                    {profile.codexWireAPI}
                                  </span>
                                ) : null}
                                {profile.codexEnvKey ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-loom-border-card bg-loom-surface-2 px-1.5 py-[3px] font-mono text-[9px] leading-none text-loom-dim">
                                    env: {profile.codexEnvKey}
                                  </span>
                                ) : null}
                                {profile.codexContextWindow ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-loom-border-card bg-loom-surface-2 px-1.5 py-[3px] font-mono text-[9px] leading-none text-loom-dim">
                                    ctx: {profile.codexContextWindow}
                                  </span>
                                ) : null}
                                {profile.codexMaxTokens ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-loom-border-card bg-loom-surface-2 px-1.5 py-[3px] font-mono text-[9px] leading-none text-loom-dim">
                                    max: {profile.codexMaxTokens}
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              SLOTS.map((slot) => {
                                const value = profile.models[slot.slot]
                                if (!value) return null
                                return (
                                  <span
                                    key={slot.slot}
                                    className="inline-flex items-center gap-1 rounded-md border border-loom-border-card bg-loom-surface-2 px-1.5 py-[3px] font-mono text-[9px] leading-none text-loom-muted-2"
                                  >
                                    <span className="text-[8px] uppercase tracking-[0.06em] text-loom-dim">
                                      {slot.label}
                                    </span>
                                    {value}
                                  </span>
                                )
                              })
                            )}
                            {Object.keys(profile.extraEnv).length > 0 ? (
                              <span className="inline-flex items-center gap-1 rounded-md border border-loom-border-card bg-loom-surface-2 px-1.5 py-[3px] font-mono text-[9px] leading-none text-loom-dim">
                                <LayoutList size={9} />
                                +{Object.keys(profile.extraEnv).length}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <div
                        className={cn(
                          'flex items-center justify-end gap-0.5',
                          'border-t border-loom-border px-3.5 py-2.5',
                          'sm:flex-col sm:justify-center sm:border-l sm:border-t-0 sm:px-3 sm:py-0',
                        )}
                      >
                        <div className="hidden sm:flex sm:flex-col sm:gap-1">
                          <button
                            type="button"
                            aria-label={profile.active ? 'Deactivate' : 'Activate'}
                            title={profile.active ? 'Deactivate' : 'Activate'}
                            onClick={() => void toggleActive(profile)}
                            disabled={activate.isPending || deactivate.isPending}
                            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-loom-dim transition-colors hover:bg-loom-hover-wash hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          >
                            {profile.active ? <PowerOff size={13} /> : <Power size={13} />}
                          </button>
                          <button
                            type="button"
                            aria-label={`Edit ${profile.name}`}
                            title="Edit"
                            onClick={() => openEdit(profile)}
                            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-loom-dim transition-colors hover:bg-loom-hover-wash hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove ${profile.name}`}
                            title="Remove"
                            onClick={() => setPendingRemoval({ profile })}
                            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-loom-dim transition-colors hover:bg-loom-red-tint-hover hover:text-loom-red-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>

                        <div className="relative sm:hidden">
                          <button
                            type="button"
                            aria-label="Actions"
                            title="Actions"
                            onClick={() => setMenuOpen(menuOpen === profile.id ? null : profile.id)}
                            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-loom-dim transition-colors hover:bg-loom-hover-wash hover:text-loom-fg"
                          >
                            <EllipsisVertical size={15} />
                          </button>
                          {menuOpen === profile.id ? (
                            <>
                              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(null)} />
                              <div className="absolute bottom-full right-0 z-20 mb-1 w-44 overflow-hidden rounded-xl border border-loom-border-card bg-loom-card shadow-lg">
                                <MobileAction
                                  icon={profile.active ? PowerOff : Power}
                                  label={profile.active ? 'Deactivate' : 'Activate'}
                                  onClick={() => { setMenuOpen(null); void toggleActive(profile) }}
                                />
                                <MobileAction
                                  icon={Pencil}
                                  label="Edit"
                                  onClick={() => { setMenuOpen(null); openEdit(profile) }}
                                />
                                <MobileAction
                                  icon={Trash2}
                                  label="Remove"
                                  danger
                                  onClick={() => { setMenuOpen(null); setPendingRemoval({ profile }) }}
                                />
                              </div>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        /* ── Editor view ── */
        <EnvSettingsEditor agentId={agentId} />
      )}

      <EnvProfileDialog
        open={dialogOpen}
        agentId={agentId}
        profile={editing}
        onOpenChange={setDialogOpen}
      />

      {/* ── remove confirm dialog ── */}
      <Dialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => !open && setPendingRemoval(null)}
        width={420}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-loom-red-tint bg-loom-red-tint-hover text-loom-red-soft">
            <Trash2 size={18} />
          </div>
          <div>
            <DialogTitle>Remove {pendingRemoval?.profile.name ?? 'environment'}?</DialogTitle>
            <DialogDescription className="mt-1.5 leading-relaxed">
              The profile will be permanently deleted
              {pendingRemoval?.profile.active
                ? ' and the active settings.json env block will be cleared'
                : ''}
              .
            </DialogDescription>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose render={<Button variant="secondary" disabled={remove.isPending} />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive-solid"
            disabled={remove.isPending}
            onClick={() => void confirmRemoval()}
          >
            {remove.isPending ? 'Removing...' : 'Remove'}
          </Button>
        </div>
      </Dialog>
    </div>
  )
}

function MobileAction({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: typeof Pencil
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-[12px] font-medium transition-colors',
        danger
          ? 'text-loom-red-soft hover:bg-loom-red-tint-hover'
          : 'text-loom-fg hover:bg-loom-hover-wash',
      )}
    >
      <Icon size={14} />
      {label}
    </button>
  )
}

function ProfileListSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1180px]">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className={cn(
            'mb-2.5 h-[120px] animate-pulse rounded-xl border border-loom-border-card bg-loom-card',
            'sm:h-[104px]',
          )}
        />
      ))}
    </div>
  )
}
