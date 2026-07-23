import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Code2, Eye, Layers, PanelRight, Plus, Sigma, Table2, Terminal, Wrench, X } from 'lucide-react'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { DB_KIND_COLOR } from './dbColors'
import { emptyDBTabState, type DBTabContent } from './dbTabs'

export interface DBTabStripProps {
  connectionId: string
  isProduction: boolean
  dirtyTabIds: ReadonlySet<string>
  onNewTable: () => void
  onNewQuery: () => void
  inspectorCollapsed: boolean
  onToggleInspector: () => void
}

const iconButtonClass =
  'flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg'

/** The active-tab accent color: the tab content's object-kind color for
 *  "table" tabs (which cover table/view/matview/function data views — the
 *  DBTabContent kind is always literally "table", the actual object kind
 *  lives on tab.object.kind), or a neutral accent for query/ddl/designer
 *  tabs, which are actions/utilities rather than object kinds. */
function dbTabAccentColor(tab: DBTabContent): string {
  if (tab.kind !== 'table') return 'var(--devdeck-accent)'
  if (tab.object.kind === 'view') return DB_KIND_COLOR.view
  if (tab.object.kind === 'matview') return DB_KIND_COLOR.matview
  if (tab.object.kind === 'function') return DB_KIND_COLOR.function
  return DB_KIND_COLOR.table
}

function tabIcon(tab: DBTabContent) {
  if (tab.kind === 'query') return <Terminal size={11} className="text-devdeck-accent-soft" />
  if (tab.kind === 'ddl') return <Code2 size={11} className="text-devdeck-dim" />
  if (tab.kind === 'designer') return <Wrench size={11} className="text-devdeck-dim" />
  const color = dbTabAccentColor(tab)
  if (tab.object.kind === 'view') return <Eye size={11} color={color} />
  if (tab.object.kind === 'matview') return <Layers size={11} color={color} />
  if (tab.object.kind === 'function') return <Sigma size={11} color={color} />
  return <Table2 size={11} color={color} />
}

function tabLabel(tab: DBTabContent) {
  if (tab.kind === 'query') return tab.label
  if (tab.kind === 'ddl') return `${tab.object.name} · DDL`
  if (tab.kind === 'designer') return tab.object ? `${tab.object.name} · Alter` : 'New table'
  return tab.object.name
}

export function DBTabStrip({
  connectionId,
  isProduction,
  dirtyTabIds,
  onNewTable,
  onNewQuery,
  inspectorCollapsed,
  onToggleInspector,
}: DBTabStripProps) {
  const state = useDevDeckStore((s) => s.dbTabs[connectionId]) ?? emptyDBTabState()
  const setActive = useDevDeckStore((s) => s.setDBActiveTab)
  const close = useDevDeckStore((s) => s.closeDBTab)
  const reorder = useDevDeckStore((s) => s.reorderDBTab)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    reorder(connectionId, String(active.id), String(over.id))
  }

  // Always render the strip, even with zero open tabs: the "+" popover
  // below is the only UI entry point for "New table"/"New SQL query", so
  // hiding this whole bar on an empty tab list (first connection open, or
  // closing the last tab) would leave no way to open anything.

  return (
    <div className="flex flex-none items-stretch border-b border-devdeck-border-menu bg-devdeck-surface-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={state.tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          <div className="flex flex-1 items-stretch overflow-x-auto px-2">
            {state.tabs.map((tab) => (
              <DBTabStripTab
                key={tab.id}
                tab={tab}
                active={tab.id === state.activeTabId}
                isProduction={isProduction}
                dirty={dirtyTabIds.has(tab.id)}
                onSelect={() => setActive(connectionId, tab.id)}
                onClose={() => close(connectionId, tab.id)}
              />
            ))}
            <TabStripPopoverMenu
              trigger={<Plus size={13} />}
              triggerClassName={cn(iconButtonClass, 'my-1.5 ml-1 flex-none self-center')}
              triggerTitle="New tab"
              triggerAriaLabel="New tab"
            >
              <button
                type="button"
                onClick={onNewTable}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash-menu"
              >
                <Table2 size={12} color={DB_KIND_COLOR.table} />
                New table
              </button>
              <button
                type="button"
                onClick={onNewQuery}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash-menu"
              >
                <Terminal size={12} className="text-devdeck-accent-soft" />
                New SQL query
              </button>
            </TabStripPopoverMenu>
          </div>
        </SortableContext>
      </DndContext>
      <button
        type="button"
        onClick={onToggleInspector}
        title={inspectorCollapsed ? 'Show inspector' : 'Hide inspector'}
        aria-label={inspectorCollapsed ? 'Show inspector' : 'Hide inspector'}
        className={cn(iconButtonClass, 'my-1.5 mr-1.5 flex-none self-center')}
      >
        <PanelRight size={13} />
      </button>
    </div>
  )
}

function DBTabStripTab({
  tab,
  active,
  isProduction,
  dirty,
  onSelect,
  onClose,
}: {
  tab: DBTabContent
  active: boolean
  isProduction: boolean
  dirty: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id })
  const label = tabLabel(tab)
  const accentColor = isProduction ? 'var(--devdeck-yellow-tint-text)' : dbTabAccentColor(tab)

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        borderBottomColor: active ? accentColor : 'transparent',
        opacity: isDragging ? 0.4 : 1,
      }}
      onMouseDown={(e) => {
        // Middle-click closes the tab, matching the terminal's PanelHeader
        // convention — a much bigger target than the small "x".
        if (e.button === 1) {
          e.preventDefault()
          onClose()
        }
      }}
      onClick={onSelect}
      className={cn(
        'group flex h-9 flex-none touch-none cursor-grab items-center gap-1.5 border-b-2 px-2.5 font-mono text-[11.5px] transition-colors active:cursor-grabbing',
        active
          ? isProduction
            ? 'bg-devdeck-yellow-tint text-devdeck-yellow-tint-text'
            : 'text-devdeck-fg'
          : 'text-devdeck-dim hover:text-devdeck-fg-2',
      )}
    >
      {tabIcon(tab)}
      <span className="max-w-[140px] truncate">{label}</span>
      {dirty ? <span className="text-devdeck-yellow">•</span> : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="opacity-0 hover:text-devdeck-red-soft group-hover:opacity-100"
        aria-label={`Close ${label}`}
      >
        <X size={11} />
      </button>
    </div>
  )
}
