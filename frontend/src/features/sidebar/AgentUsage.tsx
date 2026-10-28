import { Popover } from '@base-ui/react/popover'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
import { AgentMark } from '@/features/agent-management/AgentMark'
import { useMachines, useMachinesHealth, useWhoami } from '@/features/data/queries'
import { Select } from '@/components/ui/select'
import { request } from '@/lib/api'
import { fetchAgentUsage, type AgentUsageResult, type AgentUsageProvider } from '@/lib/machineApi'
import { cn } from '@/lib/utils'

type Provider = AgentUsageProvider
const names = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }
const statuses = { unavailable: 'Usage is unavailable for this account or CLI.', not_installed: 'Agent is not installed on this runtime.', not_logged_in: 'Sign in to this agent on the runtime.', error: 'Could not load usage. Try again.' }

function duration(minutes?: number) {
  if (!minutes) return 'Limit'
  if (minutes % 10080 === 0) return `${minutes / 10080} ${minutes === 10080 ? 'week' : 'weeks'}`
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? 'day' : 'days'}`
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`
  return `${minutes} minutes`
}

export function AgentUsage({ compact = true }: { compact?: boolean }) {
  const queryClient = useQueryClient()
  const who = useWhoami()
  const local = who.data?.role === 'runtime'
  const machinesQuery = useMachines(!local && !!who.data)
  const machines = machinesQuery.data ?? []
  const health = useMachinesHealth(machines)
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem('devdeck-usage-machine') ?? '')
  const [open, setOpen] = useState<Provider | null>(null)
  const claudeRef = useRef<HTMLDivElement>(null)
  const codexRef = useRef<HTMLDivElement>(null)
  const antigravityRef = useRef<HTMLDivElement>(null)
  useNativeOverlayBlocker(open === 'claude', claudeRef)
  useNativeOverlayBlocker(open === 'codex', codexRef)
  useNativeOverlayBlocker(open === 'antigravity', antigravityRef)
  const popupRefs = { claude: claudeRef, codex: codexRef, antigravity: antigravityRef }
  const selected = machines.find((m) => m.id === selectedId) ?? machines.find((m) => health.get(m.id)?.status === 'online') ?? machines[0]
  const offline = !!selected && health.get(selected.id)?.status === 'offline'
  const target = local ? 'local-runtime' : selected?.id
  const usage = useQuery({
    queryKey: ['agent-usage', target, open],
    queryFn: async () => {
      const result = local
        ? await request<AgentUsageResult>('GET', `/agents/${open}/usage`)
        : await fetchAgentUsage(selected!, open!)
      if (result.status === 'error') throw new Error('Usage refresh failed')
      return result
    },
    enabled: !!open && !!target && !offline,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  return (
    <div className={cn('flex flex-none gap-1', compact ? 'flex-col items-center py-1' : 'flex-col border-t border-devdeck-border p-2')}>
      {(['claude', 'codex', 'antigravity'] as const).map((provider) => {
        const cached = queryClient.getQueryData<AgentUsageResult>(['agent-usage', target, provider])
        const used = cached?.status === 'available' ? cached.windows[0]?.usedPercent : undefined
        return (
        <Popover.Root key={provider} open={open === provider} onOpenChange={(value) => setOpen((current) => value ? provider : current === provider ? null : current)}>
          <Popover.Trigger openOnHover delay={150} closeDelay={250} aria-label={`${names[provider]} usage`} className={cn('flex cursor-pointer items-center rounded-control text-devdeck-fg-2 hover:bg-devdeck-hover-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50', compact ? 'h-10 w-10 justify-center' : 'h-11 gap-3 px-3 text-[13px]')}>
            <span className="flex h-8 w-8 items-center justify-center rounded-full" style={{ background: used == null ? 'var(--devdeck-border-strong)' : `conic-gradient(var(--devdeck-run) ${(100 - used) * 3.6}deg, var(--devdeck-border-strong) 0)` }}><span className="flex h-7 w-7 items-center justify-center rounded-full bg-devdeck-glass-solid"><AgentMark id={provider} name={names[provider]} bare /></span></span>
            {!compact && <span>{names[provider]} usage</span>}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side={compact ? 'right' : 'top'} align="end" sideOffset={8} style={{ zIndex: 100 }}>
              <Popover.Popup ref={popupRefs[provider]} className="w-[300px] max-w-[90vw] max-h-[min(70vh,600px)] overflow-y-auto rounded-container border border-devdeck-border-menu bg-devdeck-glass-solid p-4 text-devdeck-fg shadow-xl outline-none">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><AgentMark id={provider} name={names[provider]} bare /> {names[provider]} usage <button type="button" aria-label="Refresh usage" className="ml-auto rounded p-1 hover:bg-devdeck-hover-wash" disabled={!target || offline || usage.isFetching} onClick={() => void usage.refetch()}><RefreshCw size={15} className={usage.isFetching ? 'animate-spin' : ''} /></button></div>
                {!local && (machines.length ? <Select aria-label="Usage runtime" value={selected?.id ?? ''} onValueChange={(id) => { setSelectedId(id); localStorage.setItem('devdeck-usage-machine', id) }} options={machines.map((m) => ({ value: m.id, label: `${m.name}${health.get(m.id)?.status === 'offline' ? ' (offline)' : ''}` }))} /> : <p className="text-xs text-devdeck-fg-2">{machinesQuery.isPending ? 'Loading runtimes…' : 'No runtimes available.'}</p>)}
                {offline && <p className="mt-3 text-xs text-devdeck-fg-2">Runtime is offline.</p>}
                {!offline && usage.isLoading && <p className="mt-3 text-xs text-devdeck-fg-2">Loading usage…</p>}
                {usage.data?.status === 'available' && usage.data.windows.map((window, index) => <div className="mt-3" key={`${window.name}-${window.durationMinutes}-${index}`}>
                  <div className="flex justify-between gap-2 text-xs"><span>{window.name} · {duration(window.durationMinutes)}</span><span>{window.usedPercent}% used</span></div>
                  <div role="progressbar" aria-label={`${window.name} ${duration(window.durationMinutes)} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={100 - window.usedPercent} className="mt-1 h-1.5 overflow-hidden rounded-full bg-devdeck-border-strong"><div className="h-full rounded-full bg-devdeck-green" style={{ width: `${100 - window.usedPercent}%` }} /></div>
                  {window.resetsAt ? <p className="mt-1 text-xs text-devdeck-fg-2">Resets {formatDistanceToNow(new Date(window.resetsAt * 1000), { addSuffix: true })}</p> : window.resetDescription ? <p className="mt-1 text-xs text-devdeck-fg-2">{window.resetDescription}</p> : null}
                </div>)}
                {usage.data && usage.data.status !== 'available' && <p className="mt-3 text-xs text-devdeck-fg-2">{statuses[usage.data.status]}</p>}
                {usage.isError && <p className="mt-3 text-xs text-devdeck-fg-2">{usage.data ? 'Refresh failed; showing last available data.' : 'Could not load usage. Try again.'}</p>}
                {usage.data && <p className="mt-3 text-[11px] text-devdeck-fg-2">Updated {formatDistanceToNow(new Date(usage.data.fetchedAt), { addSuffix: true })}</p>}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )})}
    </div>
  )
}
