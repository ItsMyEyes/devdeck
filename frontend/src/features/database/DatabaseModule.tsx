import { useMemo, useState } from 'react'
import { Database as DatabaseIcon, Pencil, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusDot } from '@/components/ui/status-dot'
import { DataLoading } from '@/features/screens/DataLoading'
import { useDBConnections, useDBEngines } from '@/features/data/queries'
import { cn } from '@/lib/utils'
import { DBCommitDialog } from './DBCommitDialog'
import { DBConnectionDialog } from './DBConnectionDialog'
import { DBDDLView } from './DBDDLView'
import { DBInspectorPanel } from './DBInspectorPanel'
import { DBObjectTree } from './DBObjectTree'
import { DBSqlEditor } from './DBSqlEditor'
import { DBTabStrip } from './DBTabStrip'
import { DBTableDesigner } from './DBTableDesigner'
import { DBTableGrid } from './DBTableGrid'
import { emptyDBTabState } from './dbTabs'
import { EngineGlyph } from './EngineGlyph'
import type { DBConnection } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const ALL_GROUPS = '__all__'

function groupLabel(group: string) {
  return group.trim() || 'Ungrouped'
}

function ConnectionCard({ conn, onOpen, onEdit }: { conn: DBConnection; onOpen: () => void; onEdit: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen()
      }}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-[13px] border p-3 text-left transition-colors',
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
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onEdit() }}
        aria-label={`Edit ${conn.name}`}
        className="flex-none rounded-md p-1 text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
      >
        <Pencil size={13} />
      </button>
    </div>
  )
}

export function DatabaseModule() {
  const { data: connections, isLoading, error, refetch } = useDBConnections()
  const activeGroup = useDevDeckStore((s) => s.dbActiveGroup)
  const setActiveGroup = useDevDeckStore((s) => s.setDBActiveGroup)
  const openAdd = useDevDeckStore((s) => s.openAddDBConnection)
  const openEdit = useDevDeckStore((s) => s.openEditDBConnection)
  const openDBTab = useDevDeckStore((s) => s.openDBTab)
  const activeConnectionId = useDevDeckStore((s) => s.dbActiveConnectionId)
  const setActiveConnectionId = useDevDeckStore((s) => s.setDBActiveConnectionId)
  const inspectorCollapsed = useDevDeckStore((s) => s.dbInspectorCollapsed)
  const setInspectorCollapsed = useDevDeckStore((s) => s.setDBInspectorCollapsed)
  const testStatus = useDevDeckStore((s) => s.dbConnectionTestStatus)
  const [query, setQuery] = useState('')
  const [dirtyTabIds, setDirtyTabIds] = useState<ReadonlySet<string>>(new Set())
  const activeConnection = connections?.find((c) => c.id === activeConnectionId) ?? null
  const { data: engines } = useDBEngines()
  // Selector reads conditionally, but the hook call itself is unconditional —
  // calling useDevDeckStore(...) only when activeConnection is truthy would
  // change the number of hooks called between renders of this same
  // component instance (activeConnection toggles within one mount).
  const activeTabState = useDevDeckStore((s) => (activeConnection ? s.dbTabs[activeConnection.id] : undefined)) ?? emptyDBTabState()
  const activeTab = activeTabState.tabs.find((t) => t.id === activeTabState.activeTabId) ?? null

  function setTabDirty(tabId: string, dirty: boolean) {
    setDirtyTabIds((prev) => {
      // Bail out (return the same reference) when the dirty flag hasn't
      // actually changed. DBTableGrid/DBSqlEditor's onDirtyChange effects
      // list the callback itself as a dependency, and the callback passed
      // down here is a fresh arrow function on every DatabaseModule render
      // — so without this early-out, every effect fire would produce a new
      // Set reference, trigger a re-render, mint a new callback identity,
      // and re-fire the effect again, forever.
      if (prev.has(tabId) === dirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(tabId)
      else next.delete(tabId)
      return next
    })
  }

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
    <>
      <div className="flex h-full min-h-0 flex-col">
        {activeConnection ? (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-64 flex-none flex-col overflow-hidden border-r border-devdeck-border-menu">
              <div className="flex h-9 flex-none items-center border-b border-devdeck-border-menu px-2.5">
                <button
                  type="button"
                  onClick={() => setActiveConnectionId(null)}
                  className="flex min-w-0 items-center gap-1.5 text-[11px] text-devdeck-dim hover:text-devdeck-fg"
                >
                  {testStatus[activeConnection.id] ? (
                    <StatusDot color={testStatus[activeConnection.id].ok ? '#56d58a' : '#f87171'} size={6} />
                  ) : null}
                  <span className="truncate">← Connections</span>
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {engines?.[activeConnection.engine] ? (
                  <DBObjectTree
                    connectionId={activeConnection.id}
                    caps={engines[activeConnection.engine]}
                    onOpenTable={(object) => openDBTab(activeConnection.id, { kind: 'table', object })}
                    onOpenDDL={(object) => openDBTab(activeConnection.id, { kind: 'ddl', object })}
                  />
                ) : (
                  <DataLoading compact label="loading capabilities…" />
                )}
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <DBTabStrip
                connectionId={activeConnection.id}
                isProduction={activeConnection.isProduction}
                dirtyTabIds={dirtyTabIds}
                onNewTable={() => openDBTab(activeConnection.id, { kind: 'designer', object: null })}
                onNewQuery={() => openDBTab(activeConnection.id, { kind: 'query', savedQueryId: null, label: 'New query' })}
                inspectorCollapsed={inspectorCollapsed}
                onToggleInspector={() => setInspectorCollapsed(!inspectorCollapsed)}
              />
              <div className="relative min-h-0 flex-1 overflow-hidden">
                {activeTabState.tabs.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-[12px] text-devdeck-dim">
                    Select a table from the tree to browse it.
                  </div>
                ) : (
                  // Every open tab stays mounted (hidden via CSS when
                  // inactive) instead of only rendering the active one —
                  // matching the terminal's PaneCanvas pattern. This is what
                  // keeps a table's pending row edits alive when switching
                  // to another tab and back, and what makes per-tab
                  // dirty-dots reflect every tab, not just the visible one.
                  activeTabState.tabs.map((tab) => (
                    <div
                      key={tab.id}
                      className={cn('absolute inset-0 overflow-auto', tab.id === activeTabState.activeTabId ? 'block' : 'hidden')}
                    >
                      {tab.kind === 'table' ? (
                        <DBTableGrid
                          connectionId={activeConnection.id}
                          object={tab.object}
                          onDirtyChange={(d) => setTabDirty(tab.id, d)}
                        />
                      ) : tab.kind === 'ddl' ? (
                        <DBDDLView connectionId={activeConnection.id} object={tab.object} />
                      ) : tab.kind === 'designer' ? (
                        <DBTableDesigner
                          connectionId={activeConnection.id}
                          object={tab.object}
                          onApplied={(object) => openDBTab(activeConnection.id, { kind: 'ddl', object })}
                        />
                      ) : (
                        <DBSqlEditor connectionId={activeConnection.id} onDirtyChange={(d) => setTabDirty(tab.id, d)} />
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
            {!inspectorCollapsed ? (
              <div className="w-72 flex-none overflow-auto border-l border-devdeck-border-menu">
                <DBInspectorPanel connection={activeConnection} activeTab={activeTab} />
              </div>
            ) : null}
          </div>
        ) : (
          <>
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
                    <ConnectionCard key={c.id} conn={c} onOpen={() => setActiveConnectionId(c.id)} onEdit={() => openEdit(c)} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <DBConnectionDialog />
      <DBCommitDialog />
    </>
  )
}
