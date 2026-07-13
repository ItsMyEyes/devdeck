import { useMemo, useState } from 'react'
import {
  Blocks,
  Check,
  CircleAlert,
  Link2,
  LockKeyhole,
  Search,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import {
  useInstallAgentSkill,
  useRemoveAgentSkill,
} from '@/features/data/queries'
import { cn } from '@/lib/utils'
import type { AgentSummary, Machine } from '@/store/types'
import { AgentMark } from './AgentMark'
import { RemoveSkillDialog } from './RemoveSkillDialog'
import type { AgentSkillInventory, CatalogSkill } from './types'

interface PendingRemoval {
  agentId: string
  agentName: string
  skillName: string
}

export function SkillsManagement({
  machine,
  agents,
  inventory,
  loading,
}: {
  machine: Machine
  agents: AgentSummary[]
  inventory: AgentSkillInventory[]
  loading: boolean
}) {
  const [query, setQuery] = useState('')
  const [agentFilter, setAgentFilter] = useState('all')
  const [category, setCategory] = useState('all')
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null)
  const installSkill = useInstallAgentSkill()
  const removeSkill = useRemoveAgentSkill()

  const catalog = useMemo(() => buildCatalog(inventory), [inventory])
  const categories = useMemo(
    () => [...new Set(catalog.map((skill) => skill.category))].sort(),
    [catalog],
  )
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase()
    return catalog.filter((skill) => {
      if (agentFilter !== 'all' && !skill.installations.has(agentFilter)) return false
      if (category !== 'all' && skill.category !== category) return false
      if (!search) return true
      return (
        skill.name.toLowerCase().includes(search) ||
        skill.description.toLowerCase().includes(search) ||
        skill.category.toLowerCase().includes(search)
      )
    })
  }, [agentFilter, catalog, category, query])
  const errors = inventory.filter((item) => item.error)
  const installedCount = catalog.reduce((total, skill) => total + skill.installations.size, 0)

  async function install(agentId: string, skillName: string) {
    try {
      await installSkill.mutateAsync({ machine, agentId, skillName })
      const agent = agents.find((item) => item.id === agentId)
      toast.success(`${skillName} installed in ${agent?.name ?? agentId}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not install skill')
    }
  }

  async function installMissing(skill: CatalogSkill) {
    const missing = agents.filter((agent) => !skill.installations.has(agent.id))
    const results = await Promise.allSettled(
      missing.map((agent) =>
        installSkill.mutateAsync({ machine, agentId: agent.id, skillName: skill.name }),
      ),
    )
    const failed = results.filter((result) => result.status === 'rejected').length
    if (failed) {
      toast.error(`${skill.name} failed on ${failed} agent${failed === 1 ? '' : 's'}`)
    } else {
      toast.success(`${skill.name} is now available in every installed agent`)
    }
  }

  async function confirmRemoval() {
    if (!pendingRemoval) return
    try {
      await removeSkill.mutateAsync({
        machine,
        agentId: pendingRemoval.agentId,
        skillName: pendingRemoval.skillName,
      })
      toast.success(`${pendingRemoval.skillName} removed from ${pendingRemoval.agentName}`)
      setPendingRemoval(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove skill')
    }
  }

  return (
    <div className="flex flex-none flex-col md:min-h-0 md:flex-1">
      <div className="grid flex-none grid-cols-2 border-b border-loom-border bg-loom-surface/20 md:grid-cols-[minmax(220px,1.2fr)_minmax(150px,0.7fr)_minmax(150px,0.7fr)]">
        <div className="col-span-2 border-b border-loom-border px-3 py-3 sm:px-4 md:col-span-1 md:border-r md:border-b-0">
          <div className="text-[15px] font-semibold tracking-[-0.015em] text-loom-fg">
            Unified skill library
          </div>
          <p className="mt-1 max-w-[56ch] text-[11.5px] leading-relaxed text-loom-muted-2">
            Discover local skills, compare coverage, and install one skill across every agent.
          </p>
        </div>
        <div className="border-r border-loom-border px-3 py-3 sm:px-4">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-loom-dim">
            Unique skills
          </div>
          <div className="mt-1 font-mono text-[19px] font-semibold text-loom-fg">{catalog.length}</div>
        </div>
        <div className="px-3 py-3 sm:px-4">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-loom-dim">
            Installations
          </div>
          <div className="mt-1 font-mono text-[19px] font-semibold text-loom-accent-soft">
            {installedCount}
          </div>
        </div>
      </div>

      <div className="grid flex-none gap-2.5 border-b border-loom-border px-3 py-3 sm:grid-cols-[minmax(0,1fr)_160px] sm:px-4 lg:grid-cols-[minmax(240px,420px)_160px_minmax(0,1fr)] lg:items-center">
        <div className="relative min-w-0 flex-1 lg:max-w-[420px]">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-loom-dim"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills"
            aria-label="Search skills"
            className="pl-8"
          />
        </div>
        <div className="w-full">
          <Select
            value={category}
            onValueChange={setCategory}
            aria-label="Filter by category"
            options={[
              { value: 'all', label: 'All categories' },
              ...categories.map((item) => ({ value: item, label: titleCase(item) })),
            ]}
          />
        </div>
        <div className="col-span-full flex min-w-0 flex-wrap gap-1.5 lg:col-span-1 lg:flex-nowrap lg:justify-end lg:overflow-x-auto lg:pb-0.5">
          <button
            type="button"
            onClick={() => setAgentFilter('all')}
            className={agentFilterButton(agentFilter === 'all')}
          >
            <Blocks size={12} />
            All agents
          </button>
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => setAgentFilter(agent.id)}
              className={agentFilterButton(agentFilter === agent.id)}
            >
              <AgentMark
                id={agent.id}
                name={agent.name}
                size="sm"
                active={agentFilter === agent.id}
              />
              {agent.name}
            </button>
          ))}
        </div>
      </div>

      {errors.length > 0 ? (
        <div className="flex flex-none items-center gap-2 border-b border-loom-yellow-tint-border bg-loom-yellow-tint px-4 py-2 text-[11px] text-loom-yellow-tint-text">
          <CircleAlert size={13} />
          Could not read skills from {errors.map((item) => item.agent.name).join(', ')}.
          Other agents remain available.
        </div>
      ) : null}

      <div className="flex-none overflow-visible p-3 sm:p-4 md:min-h-0 md:flex-1 md:overflow-auto">
        {loading && catalog.length === 0 ? (
          <SkillListSkeleton />
        ) : filtered.length === 0 ? (
          <div className="flex min-h-[280px] flex-col items-center justify-center rounded-xl border border-dashed border-loom-border-strong text-center">
            <Blocks size={24} strokeWidth={1.5} className="text-loom-dim-2" />
            <div className="mt-3 text-[12.5px] font-medium text-loom-muted">No skills match this view</div>
            <div className="mt-1 text-[11px] text-loom-dim">Clear the search or choose another agent.</div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-2">
            {filtered.map((skill) => {
              const portable = !skill.readOnly
              const missing = agents.filter((agent) => !skill.installations.has(agent.id))
              return (
                <article
                  key={skill.name}
                  className="grid gap-3 rounded-xl border border-loom-border-card bg-loom-card px-3 py-3 transition-colors hover:border-loom-border-strong sm:px-3.5 md:grid-cols-[minmax(220px,1fr)_auto] md:items-center"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-loom-border-card bg-loom-surface-2 text-loom-muted-2">
                      <Sparkles size={14} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate font-mono text-[12.5px] font-semibold text-loom-fg">
                          {skill.name}
                        </h3>
                        <span className="rounded-md border border-loom-border-card bg-loom-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-loom-muted-2">
                          {titleCase(skill.category)}
                        </span>
                        {skill.readOnly ? (
                          <span className="inline-flex items-center gap-1 font-mono text-[9.5px] text-loom-dim">
                            <LockKeyhole size={10} />
                            System
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 line-clamp-2 max-w-[72ch] text-[11.5px] leading-relaxed text-loom-muted-2">
                        {skill.description || 'No description provided by this skill.'}
                      </p>
                    </div>
                  </div>

                  <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-loom-border pt-3 md:justify-end md:border-t-0 md:pt-0">
                    <span className="mr-1 whitespace-nowrap font-mono text-[9.5px] text-loom-dim">
                      {skill.installations.size}/{agents.length}
                    </span>
                    {agents.map((agent) => {
                      const installation = skill.installations.get(agent.id)
                      const installed = Boolean(installation)
                      const locked = installation?.readOnly ?? false
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          aria-label={
                            locked
                              ? `${skill.name} is managed by ${agent.name}`
                              : installed
                                ? `Remove ${skill.name} from ${agent.name}`
                                : `Install ${skill.name} in ${agent.name}`
                          }
                          disabled={locked || installSkill.isPending || removeSkill.isPending}
                          onClick={() => {
                            if (installed) {
                              setPendingRemoval({
                                agentId: agent.id,
                                agentName: agent.name,
                                skillName: skill.name,
                              })
                            } else if (portable) {
                              void install(agent.id, skill.name)
                            }
                          }}
                          title={
                            locked
                              ? `${skill.name} is managed by ${agent.name}`
                              : installed
                                ? `Remove from ${agent.name}`
                                : portable
                                  ? `Install in ${agent.name}`
                                  : 'System skills cannot be copied'
                          }
                          className={cn(
                            'flex h-9 min-w-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2 transition-colors sm:h-8',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                            installed
                              ? 'border-loom-border-accent bg-loom-accent-tint text-loom-accent-soft'
                              : 'border-loom-border-card bg-loom-surface-2 text-loom-dim hover:border-loom-border-strong hover:text-loom-muted',
                            (locked || (!installed && !portable)) && 'cursor-not-allowed opacity-55',
                          )}
                        >
                          <AgentMark id={agent.id} name={agent.name} size="sm" active={installed} />
                          <span className="hidden text-[10.5px] sm:inline">{agent.name}</span>
                          {installed ? <Check size={10} strokeWidth={2.5} /> : <Link2 size={10} />}
                        </button>
                      )
                    })}
                    {portable && missing.length > 1 ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="ml-auto sm:ml-1"
                        disabled={installSkill.isPending}
                        onClick={() => void installMissing(skill)}
                      >
                        Install on missing
                      </Button>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>

      <RemoveSkillDialog
        open={pendingRemoval !== null}
        agentName={pendingRemoval?.agentName ?? ''}
        skillName={pendingRemoval?.skillName ?? ''}
        pending={removeSkill.isPending}
        onOpenChange={(open) => !open && setPendingRemoval(null)}
        onConfirm={() => void confirmRemoval()}
      />
    </div>
  )
}

function buildCatalog(inventory: AgentSkillInventory[]): CatalogSkill[] {
  const catalog = new Map<string, CatalogSkill>()
  for (const item of inventory) {
    for (const skill of item.skills) {
      const existing = catalog.get(skill.name)
      if (existing) {
        existing.installations.set(item.agent.id, skill)
        existing.readOnly = existing.readOnly && skill.readOnly
        if (!existing.description && skill.description) existing.description = skill.description
        if (existing.category === 'general' && skill.category !== 'general') {
          existing.category = skill.category
        }
      } else {
        catalog.set(skill.name, {
          ...skill,
          installations: new Map([[item.agent.id, skill]]),
        })
      }
    }
  }
  return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function agentFilterButton(active: boolean) {
  return cn(
    'flex h-9 flex-none cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-[11px] transition-colors sm:h-8',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
    active
      ? 'border-loom-border-accent bg-loom-accent-tint text-loom-accent-soft'
      : 'border-loom-border-card bg-loom-surface-2 text-loom-muted hover:text-loom-fg',
  )
}

function titleCase(value: string) {
  return value
    .replaceAll(/[-_]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function SkillListSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-2" aria-label="Loading skills">
      {[0, 1, 2, 3, 4].map((item) => (
        <div
          key={item}
          className="grid animate-pulse gap-3 rounded-xl border border-loom-border-card bg-loom-card px-3.5 py-3 md:grid-cols-[minmax(220px,1fr)_280px]"
        >
          <div className="flex gap-3">
            <div className="h-8 w-8 rounded-lg bg-loom-elevated" />
            <div className="flex-1">
              <div className="h-3 w-36 rounded bg-loom-elevated" />
              <div className="mt-2 h-2.5 max-w-[440px] rounded bg-loom-surface-2" />
            </div>
          </div>
          <div className="h-7 rounded-md bg-loom-surface-2" />
        </div>
      ))}
    </div>
  )
}
