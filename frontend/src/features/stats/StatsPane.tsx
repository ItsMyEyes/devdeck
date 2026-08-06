import { useMachines, useMachineStats, useSSHStats } from '@/features/data/queries'
import type { StatsTarget } from '@/features/terminal/paneTree'
import type { HostStats, Usage } from '@/store/types'
import { useRollingSamples } from './useRollingSamples'
import { MetricChart } from './MetricChart'

/** ~5 minutes at the 2s poll interval. */
const SAMPLE_CAP = 150

function fmtBytes(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function pctOf(u: Usage): number {
  return u.total > 0 ? (u.used / u.total) * 100 : 0
}

function MetricRow({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">{label}</span>
        <span className="font-mono text-[12px] text-devdeck-fg">{value}</span>
      </div>
      {children}
    </div>
  )
}

/** Disk renders as a bar, not a series: it moves on a scale of hours, so a
 *  five-minute time axis of it would be a flat line pretending to be
 *  information. */
function DiskBar({ pct }: { pct: number }) {
  return (
    // The track uses `hover-wash` rather than the brief's `surface-2` or the
    // in-flight retune's `card-wash`: those two tokens exist in only one of
    // the two globals.css revisions each, and Tailwind v4 emits no rule at
    // all for an unknown `--color-devdeck-*` key, so either choice renders
    // the track fully transparent on one side of the retune. `hover-wash` is
    // defined identically (rgba(255,255,255,0.035)) in both.
    <div className="h-2 w-full overflow-hidden rounded-full bg-devdeck-hover-wash">
      <div className="h-full rounded-full bg-devdeck-accent" style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  )
}

export function StatsPane({ target, visible }: { target: StatsTarget; visible: boolean }) {
  const isMachine = target.kind === 'machine'
  const machines = useMachines(isMachine && visible)
  const machine = isMachine ? machines.data?.find((m) => m.id === target.machineId) : undefined

  const machineQuery = useMachineStats(machine, isMachine && visible)
  const sshQuery = useSSHStats(isMachine ? undefined : target.connectionId, !isMachine && visible)
  const query = isMachine ? machineQuery : sshQuery

  const stats = query.data as HostStats | undefined
  const cpuSeries = useRollingSamples(stats, SAMPLE_CAP)

  if (query.isLoading && !stats) {
    return <div className="p-4 font-mono text-[11px] text-devdeck-fg-2">Loading metrics…</div>
  }
  // `red`, not the brief's `red-soft` or the retune's `err`: same
  // one-sided-token problem as DiskBar's track. `--color-devdeck-red` is
  // defined in both revisions, and the retune aliases it straight to
  // `--devdeck-err`, so this is the intended colour either way.
  if (query.error) {
    return (
      <div className="p-4 font-mono text-[11px] text-devdeck-red">
        {query.error instanceof Error ? query.error.message : 'Failed to read host metrics'}
      </div>
    )
  }
  if (!stats) {
    return <div className="p-4 font-mono text-[11px] text-devdeck-fg-2">No sample yet.</div>
  }
  if (!stats.supported) {
    return (
      <div className="p-4 font-mono text-[11px] text-devdeck-fg-2">
        {stats.reason || 'This host cannot be measured.'}
      </div>
    )
  }

  const cpuData = cpuSeries.map((s) => ({ value: s.cpuPct ?? 0 }))
  const memData = cpuSeries.map((s) => ({ value: pctOf(s.mem) }))

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      <MetricRow label="CPU" value={stats.cpuPct === null ? '—' : `${Math.round(stats.cpuPct)}%`}>
        <MetricChart data={cpuData} />
      </MetricRow>

      <MetricRow label="MEM" value={`${fmtBytes(stats.mem.used)} / ${fmtBytes(stats.mem.total)}`}>
        <MetricChart data={memData} />
      </MetricRow>

      <MetricRow label="DISK" value={`${fmtBytes(stats.disk.used)} / ${fmtBytes(stats.disk.total)}`}>
        <DiskBar pct={pctOf(stats.disk)} />
      </MetricRow>
    </div>
  )
}
