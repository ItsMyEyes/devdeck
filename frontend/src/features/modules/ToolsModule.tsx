import { useState } from 'react'
import { ModuleHeader } from './ModuleHeader'
import { TOOL_REGISTRY } from './tools/registry'
import { ToolsSidebar } from './tools/ToolsSidebar'

/** Workspace-agnostic utility tools: data beautifier + document conversion. Sidebar scales as more tools are added. */
export function ToolsModule() {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState(TOOL_REGISTRY[0].id)

  const active = TOOL_REGISTRY.find((t) => t.id === activeId) ?? TOOL_REGISTRY[0]
  const Active = active.Component

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ModuleHeader title="Tools" meta={`${TOOL_REGISTRY.length} tools`} />
      <div className="flex min-h-0 flex-1">
        <ToolsSidebar tools={TOOL_REGISTRY} activeId={active.id} onSelect={setActiveId} query={query} onQueryChange={setQuery} />
        <div className="flex min-h-0 flex-1 flex-col p-3.5">
          <Active />
        </div>
      </div>
    </div>
  )
}
