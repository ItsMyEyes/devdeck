import { useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ModuleHeader } from './ModuleHeader'
import { TOOL_REGISTRY } from './tools/registry'
import { ToolsSidebar } from './tools/ToolsSidebar'

/**
 * Workspace-agnostic utility tools. Desktop keeps a fixed 240px rail beside the
 * active tool. On mobile the UI is list→detail: the tool list fills the screen
 * until a tool is picked, then the tool fills the screen with a back chevron.
 */
export function ToolsModule() {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState(TOOL_REGISTRY[0].id)
  // Mobile only — desktop always renders both panes via md:* overrides.
  const [mobileDetail, setMobileDetail] = useState(false)

  const active = TOOL_REGISTRY.find((t) => t.id === activeId) ?? TOOL_REGISTRY[0]
  const Active = active.Component

  function selectTool(id: string) {
    setActiveId(id)
    setMobileDetail(true)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ModuleHeader title="Tools" meta={`${TOOL_REGISTRY.length} tools`} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <div
          className={cn(
            'min-h-0 flex-1 md:w-[240px] md:flex-none',
            mobileDetail ? 'hidden md:block' : 'block',
          )}
        >
          <ToolsSidebar
            tools={TOOL_REGISTRY}
            activeId={active.id}
            onSelect={selectTool}
            query={query}
            onQueryChange={setQuery}
          />
        </div>
        <div
          className={cn(
            'min-h-0 flex-1 flex-col p-3.5',
            mobileDetail ? 'flex' : 'hidden md:flex',
          )}
        >
          <button
            type="button"
            onClick={() => setMobileDetail(false)}
            className="mb-2.5 flex flex-none items-center gap-1 self-start rounded-md py-1 font-mono text-[11px] text-loom-muted transition-colors hover:text-loom-fg md:hidden"
          >
            <ChevronLeft size={14} />
            All tools
          </button>
          <Active />
        </div>
      </div>
    </div>
  )
}
