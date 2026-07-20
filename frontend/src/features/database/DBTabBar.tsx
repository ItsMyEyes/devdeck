import { Table2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { emptyDBTabState } from './dbTabs'

export function DBTabBar({ connectionId, isProduction }: { connectionId: string; isProduction: boolean }) {
  const state = useDevDeckStore((s) => s.dbTabs[connectionId]) ?? emptyDBTabState()
  const setActive = useDevDeckStore((s) => s.setDBActiveTab)
  const close = useDevDeckStore((s) => s.closeDBTab)

  if (state.tabs.length === 0) return null

  return (
    <div className="flex flex-none items-center gap-1 overflow-x-auto border-b border-devdeck-border-menu bg-devdeck-surface-2 px-2">
      {state.tabs.map((tab) => {
        const active = tab.id === state.activeTabId
        const label =
          tab.kind === 'query'
            ? tab.label
            : tab.kind === 'ddl'
              ? `${tab.object.name} · DDL`
              : tab.kind === 'designer'
                ? tab.object
                  ? `${tab.object.name} · Alter`
                  : 'New table'
                : tab.object.name
        return (
          <div
            key={tab.id}
            onClick={() => setActive(connectionId, tab.id)}
            className={cn(
              'group flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-t-md border-b-2 px-2.5 font-mono text-[11.5px] transition-colors',
              active
                ? isProduction
                  ? 'border-devdeck-yellow-tint-text bg-devdeck-yellow-tint text-devdeck-yellow-tint-text'
                  : 'border-devdeck-accent text-devdeck-fg'
                : 'border-transparent text-devdeck-dim hover:text-devdeck-fg-2',
            )}
          >
            <Table2 size={11} />
            <span className="max-w-[140px] truncate">{label}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); close(connectionId, tab.id) }}
              className="opacity-0 hover:text-devdeck-red-soft group-hover:opacity-100"
              aria-label={`Close ${label}`}
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
