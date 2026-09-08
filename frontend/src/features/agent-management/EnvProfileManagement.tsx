import { useMemo, useState } from 'react'
import {
  ChevronRight,
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
  Settings,
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
import type { AgentSummary, Machine } from '@/store/types'
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

/** Agents whose LLM env profiles DevDeck can write — see the backend's
 *  `validateEnvProfileAgent`. Every other installed agent still gets this
 *  panel, showing its config file alone. */
const ENV_PROFILE_AGENTS = new Set(['claude', 'codex'])

interface PendingRemoval {
  profile: EnvProfileSummary
}

export function EnvProfileManagement({
  machine,
  agentId,
  allSettingsAgents,
  profiles,
  loading,
  onSelectAgent,
}: {
  machine: Machine
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
  // Only Claude and Codex have LLM env profiles; the other agents get this
  // panel purely for their config file. Deriving the shown tab instead of
  // syncing state means switching to pi lands on the editor without a frame of
  // an empty profile list, and switching back to Claude restores the tab the
  // operator was actually on.
  const supportsProfiles = ENV_PROFILE_AGENTS.has(agentId)
  const activeTab: InnerTab = supportsProfiles ? innerTab : 'editor'
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
        await deactivate.mutateAsync({ machine, agentId })
        toast.success(`${profile.name} deactivated`)
      } else {
        await activate.mutateAsync({ machine, agentId, profileId: profile.id })
        toast.success(`${profile.name} is now active`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not change active profile')
    }
  }

  async function confirmRemoval() {
    if (!pendingRemoval) return
    try {
      await remove.mutateAsync({ machine, agentId, profileId: pendingRemoval.profile.id })
      toast.success(`${pendingRemoval.profile.name} removed`)
      setPendingRemoval(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove profile')
    }
  }

  const currentAgent = allSettingsAgents.find((a) => a.id === agentId)

  return (
    <div className="flex flex-none flex-col md:min-h-[24rem] md:flex-1">
      {/* ── stat header ── */}
      <div
        className={cn(
          'grid flex-none grid-cols-2 border-b border-devdeck-border bg-devdeck-pane/15',
          supportsProfiles && 'md:grid-cols-[minmax(260px,1.2fr)_140px_140px]',
        )}
      >
        {/* description + agent switcher */}
        <div
          className={cn(
            'col-span-2 flex flex-col px-4 pb-3 pt-3',
            // The border-and-column treatment only earns its keep next to the
            // stat tiles; without them it would draw a rule down empty space.
            supportsProfiles && 'border-b border-devdeck-border md:col-span-1 md:border-b-0 md:border-r md:pb-0',
          )}
        >
          <div className="flex items-center gap-2.5">
            <Settings size={16} className="text-devdeck-fg-2" />
            <h2 className="text-[15px] font-semibold tracking-[-0.015em] text-devdeck-fg">
              {supportsProfiles ? 'LLM environments' : 'Agent settings'}
            </h2>
          </div>
          <p className="mt-1.5 max-w-[48ch] text-[11.5px] leading-relaxed text-devdeck-fg-2">
            {supportsProfiles ? (
              <>
                Save provider profiles and switch the live one. Activating writes the{' '}
                <span className="font-mono">env</span> block into settings.json.
              </>
            ) : (
              <>Edit this agent&apos;s own configuration file on {machine.name}.</>
            )}
          </p>

          {/* agent switcher pills */}
          {allSettingsAgents.length > 1 ? (
            <div className="mt-5 mb-5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Select agent">
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
                      ? 'border-devdeck-line bg-devdeck-on text-devdeck-fg shadow-xs'
                      : 'border-devdeck-border-card text-devdeck-fg-2 hover:border-devdeck-border-strong hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
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
              <span className="text-[11px] font-medium text-devdeck-fg-2">{currentAgent.name}</span>
            </div>
          ) : null}
        </div>

        {supportsProfiles ? (
          <>
            {/* profiles count */}
            <div className="flex flex-col justify-center border-r border-devdeck-border px-4 py-3">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-devdeck-fg-2">
                Profiles
              </span>
              <span className="mt-0.5 font-mono text-[22px] font-semibold leading-none tracking-tight text-devdeck-fg">
                {profiles.length}
              </span>
            </div>

            {/* active count */}
            <div className="flex flex-col justify-center px-4 py-3">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-devdeck-fg-2">
                Active
              </span>
              <span
                className={cn(
                  'mt-0.5 font-mono text-[22px] font-semibold leading-none tracking-tight',
                  activeProfile ? 'text-devdeck-run' : 'text-devdeck-fg-2',
                )}
              >
                {activeProfile ? 1 : 0}
              </span>
            </div>
          </>
        ) : null}
      </div>

      {/* ── inner tabs ── */}
      <div
        className="flex flex-none gap-1 border-b border-devdeck-border bg-devdeck-pane px-4 py-2"
        role="tablist"
        aria-label="Settings views"
      >
        {supportsProfiles ? (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'profiles'}
            onClick={() => setInnerTab('profiles')}
            className={cn(
              'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              activeTab === 'profiles'
                ? 'bg-devdeck-on text-devdeck-fg'
                : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
            )}
          >
            <Layers size={13} />
            Profiles
          </button>
        ) : null}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'editor'}
          onClick={() => setInnerTab('editor')}
          className={cn(
            'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            activeTab === 'editor'
              ? 'bg-devdeck-on text-devdeck-fg'
              : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
          )}
        >
          <Code size={13} />
          Settings file
        </button>
      </div>

      {activeTab === 'profiles' ? (
        <>
          {/* ── active env collapsible list ── */}
          {activeEnv ? (
            <div className="flex-none border-b border-devdeck-border bg-devdeck-pane/10">
              <button
                type="button"
                onClick={() => setEnvExpanded(!envExpanded)}
                className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-[11px] font-medium text-devdeck-fg-2 transition-colors hover:text-devdeck-fg"
              >
                <ChevronRight
                  size={12}
                  className={cn('flex-none transition-transform', envExpanded && 'rotate-90')}
                />
                <Power size={11} className="text-devdeck-run" />
                {activeProfile?.agentId === 'codex' ? 'Active config' : 'Active environment variables'}
                <span className="font-mono text-[9px] text-devdeck-fg-2">{Object.keys(activeEnv).length} keys</span>
              </button>
              {envExpanded ? (
                <div className="grid gap-px border-t border-devdeck-border bg-devdeck-border">
                  {Object.entries(activeEnv).map(([key, value]) => (
                    <div
                      key={key}
                      className="grid grid-cols-[1fr_1.5fr] gap-3 bg-devdeck-pane px-4 py-1.5 font-mono text-[10px] leading-relaxed"
                    >
                      <span className="truncate text-devdeck-fg-2">{key}</span>
                      <span className="truncate text-devdeck-fg">{value}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ── search + add toolbar ── */}
          <div className="flex flex-none flex-col gap-2.5 border-b border-devdeck-border px-4 py-3 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1 sm:max-w-[380px]">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-devdeck-fg-2"
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
              <div className="flex min-h-[280px] flex-col items-center justify-center rounded-xl border border-dashed border-devdeck-border-strong text-center">
                <Search size={24} strokeWidth={1.5} className="text-devdeck-fg-2" />
                <p className="mt-3 text-[12.5px] font-medium text-devdeck-fg-2">
                  No environments match this search
                </p>
                <button
                  type="button"
                  className="mt-2 cursor-pointer text-[11px] text-devdeck-accent hover:underline"
                  onClick={() => setQuery('')}
                >
                  Clear search
                </button>
              </div>
            ) : profiles.length === 0 ? (
              <div className="flex min-h-[340px] flex-col items-center justify-center rounded-xl border border-dashed border-devdeck-border-strong text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-devdeck-border-card bg-devdeck-card-wash text-devdeck-fg-2">
                  <Settings size={18} strokeWidth={1.5} />
                </div>
                <p className="mt-3 text-[13px] font-medium text-devdeck-fg-2">No LLM environments saved</p>
                <p className="mt-1.5 max-w-[44ch] text-[11.5px] leading-relaxed text-devdeck-fg-2">
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
                      'group relative overflow-hidden rounded-xl border bg-devdeck-glass-solid transition-all',
                      profile.active
                        ? 'border-devdeck-green-tint-border shadow-[inset_0_0_0_1px_rgba(127,179,127,.25)]'
                        : 'border-devdeck-border-card hover:border-devdeck-border-strong hover:shadow-sm',
                    )}
                  >
                    {profile.active ? (
                      <div className="absolute left-0 top-0 h-full w-0.5 bg-devdeck-run" />
                    ) : null}

                    <div className="flex flex-col gap-0 sm:flex-row sm:items-stretch">
                      <div className="flex min-w-0 flex-1 items-start gap-3 px-3.5 py-3 sm:px-4 sm:py-3.5">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={profile.active}
                          aria-label={profile.active ? `${profile.name} is active` : `Activate ${profile.name}`}
                          title={profile.active ? 'Active - click to clear' : 'Activate this environment'}
                          onClick={() => void toggleActive(profile)}
                          disabled={activate.isPending || deactivate.isPending}
                          className={cn(
                            'mt-0.5 flex h-[18px] w-[18px] flex-none cursor-pointer items-center justify-center rounded-full border-2 transition-all',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                            profile.active
                              ? 'border-devdeck-run bg-devdeck-run text-devdeck-pane shadow-xs'
                              : 'border-devdeck-border-strong text-transparent hover:border-devdeck-run',
                          )}
                        >
                          <span className="h-[7px] w-[7px] rounded-full bg-current" />
                        </button>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3
                              className={cn(
                                'truncate text-[13px] font-semibold',
                                profile.active ? 'text-devdeck-run' : 'text-devdeck-fg',
                              )}
                            >
                              {profile.name}
                            </h3>

                            {profile.active ? (
                              <span className="inline-flex items-center gap-1 rounded-md border border-devdeck-green-tint-border bg-devdeck-green-tint px-1.5 py-0.5 text-[9.5px] font-medium text-devdeck-run">
                                <Power size={9} />
                                Active
                              </span>
                            ) : null}

                            {profile.hasToken ? null : (
                              <span className="inline-flex items-center gap-1 rounded-md border border-devdeck-yellow-tint-border bg-devdeck-yellow-tint px-1.5 py-0.5 text-[9.5px] text-devdeck-yellow-tint-text">
                                <CircleAlert size={9} />
                                No token
                              </span>
                            )}
                          </div>

                          <div className="mt-1.5 flex items-center gap-1.5">
                            <Globe size={10} className="flex-none text-devdeck-fg-2" />
                            <span className="truncate font-mono text-[10px] text-devdeck-fg-2">
                              {profile.baseUrl || '- no base url -'}
                            </span>
                          </div>

                          <div className="mt-2 flex flex-wrap gap-1">
                            {profile.agentId === 'codex' ? (
                              <>
                                {profile.models['model'] ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-devdeck-border-card bg-devdeck-card-wash px-1.5 py-[3px] font-mono text-[9px] leading-none text-devdeck-fg-2">
                                    <span className="text-[8px] uppercase tracking-[0.06em] text-devdeck-fg-2">model</span>
                                    {profile.models['model']}
                                  </span>
                                ) : null}
                                {profile.codexProviderName ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-devdeck-border-card bg-devdeck-card-wash px-1.5 py-[3px] font-mono text-[9px] leading-none text-devdeck-fg-2">
                                    <span className="text-[8px] uppercase tracking-[0.06em] text-devdeck-fg-2">provider</span>
                                    {profile.codexProviderName}
                                  </span>
                                ) : null}
                                {profile.codexWireAPI ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-devdeck-border-card bg-devdeck-card-wash px-1.5 py-[3px] font-mono text-[9px] leading-none text-devdeck-fg-2">
                                    {profile.codexWireAPI}
                                  </span>
                                ) : null}
                                {profile.codexEnvKey ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-devdeck-border-card bg-devdeck-card-wash px-1.5 py-[3px] font-mono text-[9px] leading-none text-devdeck-fg-2">
                                    env: {profile.codexEnvKey}
                                  </span>
                                ) : null}
                                {profile.codexContextWindow ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-devdeck-border-card bg-devdeck-card-wash px-1.5 py-[3px] font-mono text-[9px] leading-none text-devdeck-fg-2">
                                    ctx: {profile.codexContextWindow}
                                  </span>
                                ) : null}
                                {profile.codexMaxTokens ? (
                                  <span className="inline-flex items-center gap-1 rounded-md border border-devdeck-border-card bg-devdeck-card-wash px-1.5 py-[3px] font-mono text-[9px] leading-none text-devdeck-fg-2">
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
                                    className="inline-flex items-center gap-1 rounded-md border border-devdeck-border-card bg-devdeck-card-wash px-1.5 py-[3px] font-mono text-[9px] leading-none text-devdeck-fg-2"
                                  >
                                    <span className="text-[8px] uppercase tracking-[0.06em] text-devdeck-fg-2">
                                      {slot.label}
                                    </span>
                                    {value}
                                  </span>
                                )
                              })
                            )}
                            {Object.keys(profile.extraEnv).length > 0 ? (
                              <span className="inline-flex items-center gap-1 rounded-md border border-devdeck-border-card bg-devdeck-card-wash px-1.5 py-[3px] font-mono text-[9px] leading-none text-devdeck-fg-2">
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
                          'border-t border-devdeck-border px-3.5 py-2.5',
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
                            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          >
                            {profile.active ? <PowerOff size={13} /> : <Power size={13} />}
                          </button>
                          <button
                            type="button"
                            aria-label={`Edit ${profile.name}`}
                            title="Edit"
                            onClick={() => openEdit(profile)}
                            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove ${profile.name}`}
                            title="Remove"
                            onClick={() => setPendingRemoval({ profile })}
                            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-devdeck-fg-2 transition-colors hover:bg-devdeck-red-tint-hover hover:text-devdeck-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
                            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
                          >
                            <EllipsisVertical size={15} />
                          </button>
                          {menuOpen === profile.id ? (
                            <>
                              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(null)} />
                              <div className="absolute bottom-full right-0 z-20 mb-1 w-44 overflow-hidden rounded-xl border border-devdeck-border-card bg-devdeck-glass-solid shadow-lg">
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
        <EnvSettingsEditor machine={machine} agentId={agentId} />
      )}

      <EnvProfileDialog
        open={dialogOpen}
        machine={machine}
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
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-devdeck-red-tint bg-devdeck-red-tint-hover text-devdeck-err">
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
          ? 'text-devdeck-err hover:bg-devdeck-red-tint-hover'
          : 'text-devdeck-fg hover:bg-devdeck-hover-wash',
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
            'mb-2.5 h-[120px] animate-pulse rounded-xl border border-devdeck-border-card bg-devdeck-glass-solid',
            'sm:h-[104px]',
          )}
        />
      ))}
    </div>
  )
}
