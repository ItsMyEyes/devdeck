import { useMemo, useState } from 'react'
import { Database as DatabaseIcon, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DataLoading } from '@/features/screens/DataLoading'
import { useDBConnections } from '@/features/data/queries'
import { cn } from '@/lib/utils'
import type { DBConnection } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const ALL_GROUPS = '__all__'

function groupLabel(group: string) {
  return group.trim() || 'Ungrouped'
}

function EngineGlyph({ engine }: { engine: DBConnection['engine'] }) {
  const label = engine === 'postgres' ? 'PG' : engine === 'mysql' ? 'My' : 'lite'
  return (
    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[10px] border border-devdeck-border-accent bg-devdeck-accent-tint font-mono text-[10px] font-semibold text-devdeck-accent-soft">
      {label}
    </span>
  )
}

function ConnectionCard({ conn, onEdit }: { conn: DBConnection; onEdit: () => void }) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[13px] border p-3 text-left transition-colors',
        conn.isProduction
          ? 'border-devdeck-yellow-tint-border bg-devdeck-yellow-tint hover:bg-devdeck-yellow-tint-hover'
          : 'border-devdeck-border-card bg-devdeck-card hover:bg-devdeck-hover-wash',
      )}
    >
      <EngineGlyph engine={conn.engine} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-devdeck-fg">{conn.name}</div>
        <div className="truncate font-mono text-[11px] text-devdeck-dim">
          {conn.engine === 'sqlite' ? conn.database : `${conn.host}:${conn.port}/${conn.database}`}
        </div>
      </div>
      {conn.isProduction ? (
        <span className="flex-none rounded-full bg-devdeck-yellow-tint-text/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-devdeck-yellow-tint-text">
          prod
        </span>
      ) : null}
    </button>
  )
}

export function DatabaseModule() {
  const { data: connections, isLoading, error, refetch } = useDBConnections()
  const activeGroup = useDevDeckStore((s) => s.dbActiveGroup)
  const setActiveGroup = useDevDeckStore((s) => s.setDBActiveGroup)
  const openAdd = useDevDeckStore((s) => s.openAddDBConnection)
  const openEdit = useDevDeckStore((s) => s.openEditDBConnection)
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    if (!connections) return []
    const set = new Set(connections.map((c) => groupLabel(c.group)))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [connections])

  const visible = useMemo(() => {
    if (!connections) return []
    const needle = query.trim().toLowerCase()
    return connections.filter((c) => {
      if (activeGroup !== ALL_GROUPS && groupLabel(c.group) !== activeGroup) return false
      if (!needle) return true
      return c.name.toLowerCase().includes(needle) || c.host.toLowerCase().includes(needle)
    })
  }, [connections, activeGroup, query])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center gap-2.5 border-b border-devdeck-border-menu px-4 py-3">
        <DatabaseIcon size={16} className="text-devdeck-muted" />
        <h1 className="text-[15px] font-semibold text-devdeck-fg">Database</h1>
        <span className="rounded-full bg-devdeck-popover px-2 py-0.5 font-mono text-[11px] text-devdeck-dim">
          {connections?.length ?? 0}
        </span>
        <div className="flex-1" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search connections…"
          className="w-56 font-mono"
        />
        <Button variant="ghost" size="icon" onClick={() => refetch()} aria-label="Refresh">
          <RefreshCw size={14} />
        </Button>
        <Button onClick={openAdd}>
          <Plus size={14} />
          New connection
        </Button>
      </div>

      {groups.length > 0 ? (
        <div className="flex flex-none items-center gap-1.5 overflow-x-auto border-b border-devdeck-border-menu px-4 py-2">
          <button
            type="button"
            onClick={() => setActiveGroup(ALL_GROUPS)}
            className={cn(
              'h-7 flex-none rounded-full px-3 font-mono text-[11px] transition-colors',
              activeGroup === ALL_GROUPS ? 'bg-devdeck-accent-tint text-devdeck-accent-soft' : 'text-devdeck-muted hover:bg-devdeck-hover-wash',
            )}
          >
            All
          </button>
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setActiveGroup(g)}
              className={cn(
                'h-7 flex-none rounded-full px-3 font-mono text-[11px] transition-colors',
                activeGroup === g ? 'bg-devdeck-accent-tint text-devdeck-accent-soft' : 'text-devdeck-muted hover:bg-devdeck-hover-wash',
              )}
            >
              {g}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {isLoading ? (
          <DataLoading compact label="loading connections…" />
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-devdeck-dim">
            <p>{error instanceof Error ? error.message : 'Failed to load connections'}</p>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-devdeck-dim">
            <DatabaseIcon size={28} className="text-devdeck-dim-2" />
            <p>{connections?.length ? 'No connections match your search.' : 'No database connections yet.'}</p>
            {!connections?.length ? (
              <Button size="sm" onClick={openAdd}>
                <Plus size={13} />
                Add your first connection
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((c) => (
              <ConnectionCard key={c.id} conn={c} onEdit={() => openEdit(c)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
