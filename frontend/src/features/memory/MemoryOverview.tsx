import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis } from 'recharts'
import { Database, Globe, GitBranch, Layers, Sparkles, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ChartContainer, ChartTooltipContent } from '@/components/ui/chart'
import { Pill } from '@/components/ui/pill'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { MemoryOperations } from './MemoryOperations'
import { useAddGlobalPreference, useMemoryStats, useMemoryTags, useMemoryTimeseries } from './useMemory'

const FACT_TYPE_COLOR: Record<string, string> = {
  world: 'var(--devdeck-blue, #5b8dee)',
  experience: 'var(--devdeck-green, #56d58a)',
  observation: 'var(--devdeck-yellow, #e0c05c)',
}

function StatTile({ label, value, Icon, color }: { label: string; value: number | string; Icon: LucideIcon; color: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-devdeck-border-card bg-devdeck-card-wash/60 p-3.5 transition-colors hover:border-devdeck-border-accent/50">
      <div
        className="flex h-8 w-8 flex-none items-center justify-center rounded-md"
        style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
      >
        <Icon size={15} strokeWidth={2} />
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">{label}</span>
        <span className="font-mono text-[20px] font-semibold leading-tight text-devdeck-fg">{value}</span>
      </div>
    </div>
  )
}

/**
 * Add a preference to the cross-project global tier. Auto-recall is now scoped
 * to each chat's own project, so this is the one place an operator can teach a
 * preference that should travel to EVERY project on the dashboard — the escape
 * hatch from that scoping. See backend memory.RecallTags / RetainGlobal.
 */
function GlobalPreferenceForm() {
  const [text, setText] = useState('')
  const add = useAddGlobalPreference()

  function submit() {
    const t = text.trim()
    if (!t || add.isPending) return
    add.mutate(t, {
      onSuccess: () => {
        setText('')
        toast.success('Saved to global preferences')
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save preference'),
    })
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-devdeck-border-card bg-devdeck-card-wash/40 p-3.5">
      <div className="flex items-center gap-1.5">
        <Globe size={13} strokeWidth={2} className="text-devdeck-accent" />
        <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Global preferences</h3>
      </div>
      <p className="text-[11.5px] leading-relaxed text-devdeck-fg-2">
        Recalled in every project&rsquo;s chats — the one kind of memory that crosses the project boundary.
        Everything else stays scoped to the project it was learned in.
      </p>
      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="e.g. Always prefer tabs over spaces"
          className="flex-1"
        />
        <Button size="lg" disabled={!text.trim() || add.isPending} onClick={submit}>
          Add
        </Button>
      </div>
    </section>
  )
}

export function MemoryOverview() {
  const stats = useMemoryStats(true)
  const tags = useMemoryTags(true)
  const timeseries = useMemoryTimeseries(true, '30d')

  if (stats.isPending) return <DataLoading label="loading memory stats…" />
  if (stats.isError) return <DataError error={stats.error} onRetry={() => stats.refetch()} />

  const s = stats.data
  const factTypes = Object.entries(s.nodes_by_fact_type ?? {})

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Facts" value={s.total_nodes} Icon={Sparkles} color="var(--devdeck-blue, #5b8dee)" />
        <StatTile label="Relations" value={s.total_links} Icon={GitBranch} color="var(--devdeck-green, #56d58a)" />
        <StatTile label="Documents" value={s.total_documents} Icon={Database} color="var(--devdeck-yellow, #e0c05c)" />
        <StatTile label="Observations" value={s.total_observations} Icon={Layers} color="var(--devdeck-accent, #a78bfa)" />
      </div>

      <GlobalPreferenceForm />

      <MemoryOperations enabled />

      {factTypes.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Facts by type</h3>
          <div className="flex flex-wrap gap-2">
            {factTypes.map(([type, count]) => (
              <Pill key={type} color={FACT_TYPE_COLOR[type] ?? 'var(--devdeck-fg-2, #888)'}>
                {type} · {count}
              </Pill>
            ))}
          </div>
        </section>
      )}

      {!timeseries.isPending && !timeseries.isError && timeseries.data.buckets.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
            Retained over the last 30 days
          </h3>
          <div className="h-[220px] rounded-lg border border-devdeck-border-card bg-devdeck-card-wash/40 p-3">
            <ChartContainer
              config={{
                world: { label: 'World', color: FACT_TYPE_COLOR.world },
                experience: { label: 'Experience', color: FACT_TYPE_COLOR.experience },
                observation: { label: 'Observation', color: FACT_TYPE_COLOR.observation },
              }}
            >
              <BarChart data={timeseries.data.buckets}>
                <CartesianGrid vertical={false} stroke="var(--devdeck-border)" />
                <XAxis dataKey="time" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltipContent />} cursor={{ fill: 'var(--devdeck-hover-wash)' }} />
                <Bar dataKey="world" stackId="a" fill="var(--color-world)" radius={[0, 0, 0, 0]} />
                <Bar dataKey="experience" stackId="a" fill="var(--color-experience)" radius={[0, 0, 0, 0]} />
                <Bar dataKey="observation" stackId="a" fill="var(--color-observation)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ChartContainer>
          </div>
        </section>
      )}

      {!tags.isPending && !tags.isError && tags.data.items.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">
            Tags ({tags.data.total})
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {tags.data.items.slice(0, 60).map((t) => (
              <Pill key={t.tag} color="var(--devdeck-fg-2, #888)" className="font-mono">
                {t.tag} <span className="opacity-60">· {t.count}</span>
              </Pill>
            ))}
          </div>
        </section>
      )}

      {s.last_memory_write_at && (
        <p className="font-mono text-[10.5px] text-devdeck-fg-2">
          Last write: {new Date(s.last_memory_write_at).toLocaleString()}
          {s.last_consolidated_at ? ` · last consolidated: ${new Date(s.last_consolidated_at).toLocaleString()}` : ''}
        </p>
      )}
    </div>
  )
}
