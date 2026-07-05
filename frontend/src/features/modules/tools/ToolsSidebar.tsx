import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolDef } from './registry'

interface ToolsSidebarProps {
  tools: ToolDef[]
  activeId: string
  onSelect: (id: string) => void
  query: string
  onQueryChange: (query: string) => void
}

/** Left rail for the Tools module: search + category-grouped tool list. Scales to many tools without crowding the detail pane. */
export function ToolsSidebar({ tools, activeId, onSelect, query, onQueryChange }: ToolsSidebarProps) {
  const filtered = tools.filter((t) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return t.label.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)
  })

  const categories = [...new Set(filtered.map((t) => t.category))]

  return (
    <div className="flex h-full w-full flex-col md:w-[240px] md:border-r md:border-loom-border">
      <div className="flex-none p-2.5">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-loom-dim" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search tools…"
            className={cn(
              'h-8 w-full rounded-md border border-loom-border-strong bg-loom-bg pr-2.5 pl-7 text-[12px] text-loom-fg',
              'placeholder:text-loom-dim-2 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-loom-border-accent',
            )}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {categories.length === 0 ? (
          <div className="px-2 py-4 text-center text-[11.5px] text-loom-dim">No tools match "{query}"</div>
        ) : (
          categories.map((category) => (
            <div key={category} className="mb-1">
              <div className="px-2 py-1.5 font-mono text-[10px] tracking-wide text-loom-dim uppercase">{category}</div>
              <div className="flex flex-col gap-0.5">
                {filtered
                  .filter((t) => t.category === category)
                  .map((t) => {
                    const active = t.id === activeId
                    return (
                      <button
                        key={t.id}
                        onClick={() => onSelect(t.id)}
                        className={cn(
                          'flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                          active
                            ? 'bg-loom-accent/10 shadow-[inset_2px_0_0_var(--loom-accent)]'
                            : 'hover:bg-loom-hover-wash',
                        )}
                      >
                        <t.icon size={14} className={cn('mt-0.5 flex-none', active ? 'text-loom-accent-soft' : 'text-loom-muted-2')} />
                        <div className="min-w-0">
                          <div className={cn('truncate text-[12px] font-medium', active ? 'text-loom-fg' : 'text-loom-muted')}>
                            {t.label}
                          </div>
                          <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-loom-dim">{t.description}</div>
                        </div>
                      </button>
                    )
                  })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
