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
    <div className="flex h-full w-full flex-col md:w-[240px] md:border-r md:border-devdeck-border">
      <div className="flex-none p-2.5">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-devdeck-dim" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search tools…"
            className={cn(
              'h-8 w-full rounded-md border border-devdeck-border-strong bg-devdeck-bg pr-2.5 pl-7 text-[12px] text-devdeck-fg',
              'placeholder:text-devdeck-dim-2 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-devdeck-border-accent',
            )}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {categories.length === 0 ? (
          <div className="px-2 py-4 text-center text-[11.5px] text-devdeck-dim">No tools match "{query}"</div>
        ) : (
          categories.map((category) => (
            <div key={category} className="mb-1">
              <div className="px-2 py-1.5 font-mono text-[10px] tracking-wide text-devdeck-dim uppercase">{category}</div>
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
                            ? 'bg-devdeck-accent/10 shadow-[inset_2px_0_0_var(--devdeck-accent)]'
                            : 'hover:bg-devdeck-hover-wash',
                        )}
                      >
                        <t.icon size={14} className={cn('mt-0.5 flex-none', active ? 'text-devdeck-accent-soft' : 'text-devdeck-muted-2')} />
                        <div className="min-w-0">
                          <div className={cn('truncate text-[12px] font-medium', active ? 'text-devdeck-fg' : 'text-devdeck-muted')}>
                            {t.label}
                          </div>
                          <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-devdeck-dim">{t.description}</div>
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
