import { ChevronRight, Code2, Database as DatabaseIcon, FileCode, Table2 } from 'lucide-react'
import { useState } from 'react'
import { useDBTree } from '@/features/data/queries'
import type { DBCaps, DBObjectRef, DBTreePath } from '@/lib/api'
import { cn } from '@/lib/utils'

interface DBObjectTreeProps {
  connectionId: string
  caps: DBCaps
  onOpenTable: (object: DBObjectRef) => void
  onOpenDDL: (object: DBObjectRef) => void
}

/** childKind maps a parent node's kind to the TreePath.kind of its children,
 *  per the engine's capability flags — a schema-less engine (mysql, sqlite)
 *  skips straight from "databases"/root to "tables"/"views". */
function childCollections(caps: DBCaps, parentKind: string): string[] {
  if (parentKind === '') {
    if (caps.multiDatabase) return ['databases']
    if (caps.schemas) return ['schemas']
    return ['tables', 'views']
  }
  if (parentKind === 'databases') return caps.schemas ? ['schemas'] : ['tables', 'views']
  if (parentKind === 'schemas') {
    const kinds = ['tables', 'views']
    if (caps.matViews) kinds.push('matviews')
    if (caps.functions) kinds.push('functions')
    return kinds
  }
  return []
}

function nodeIcon(kind: string) {
  if (kind === 'function') return <FileCode size={13} className="text-devdeck-dim" />
  if (kind === 'database' || kind === 'schema') return <DatabaseIcon size={13} className="text-devdeck-dim" />
  return <Table2 size={13} className="text-devdeck-dim" />
}

interface TreeLevelProps {
  connectionId: string
  caps: DBCaps
  path: DBTreePath
  depth: number
  parentObject: DBObjectRef
  onOpenTable: (object: DBObjectRef) => void
  onOpenDDL: (object: DBObjectRef) => void
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
}

function TreeLevel({ connectionId, caps, path, depth, parentObject, onOpenTable, onOpenDDL, expanded, onToggle }: TreeLevelProps) {
  const { data, isLoading, error } = useDBTree(connectionId, path)

  if (isLoading) {
    return <div style={{ paddingLeft: 8 + depth * 14 }} className="h-[29px] text-[11px] text-devdeck-dim">loading…</div>
  }
  if (error) {
    return (
      <div style={{ paddingLeft: 8 + depth * 14 }} className="h-[29px] text-[11px] text-devdeck-red-soft">
        {error instanceof Error ? error.message : 'failed to load'}
      </div>
    )
  }

  return (
    <>
      {(data ?? []).map((node) => {
        const key = `${path.database}/${path.schema}/${path.kind}/${node.name}`
        const isLeaf = node.kind === 'table' || node.kind === 'view' || node.kind === 'matview' || node.kind === 'function'
        const object: DBObjectRef = {
          database: path.database || (path.kind === 'databases' ? node.name : ''),
          schema: path.schema || (path.kind === 'schemas' ? node.name : parentObject.schema),
          name: isLeaf ? node.name : '',
          kind: node.kind,
        }
        const isOpen = expanded.has(key)
        const ddlEligible = node.kind === 'table' || node.kind === 'view'
        return (
          <div key={key}>
            <div className="group flex h-[29px] items-center rounded-md hover:bg-white/[0.04]">
              <button
                type="button"
                data-row-path={key}
                onClick={() => (isLeaf ? onOpenTable({ ...object, name: node.name }) : onToggle(key))}
                style={{ paddingLeft: 8 + depth * 14 }}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] text-devdeck-fg-2 group-hover:text-devdeck-fg"
              >
                {node.hasChildren && !isLeaf ? (
                  <ChevronRight size={12} className={cn('flex-none text-devdeck-dim transition-transform', isOpen && 'rotate-90')} />
                ) : (
                  <span className="w-3 flex-none" />
                )}
                {nodeIcon(node.kind)}
                <span className="truncate font-mono">{node.name}</span>
              </button>
              {ddlEligible ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onOpenDDL({ ...object, name: node.name }) }}
                  title={`View DDL for ${node.name}`}
                  aria-label={`View DDL for ${node.name}`}
                  className="mr-1.5 flex h-6 w-6 flex-none items-center justify-center rounded text-devdeck-dim opacity-0 hover:bg-devdeck-accent-tint hover:text-devdeck-accent-soft group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Code2 size={12} />
                </button>
              ) : null}
            </div>
            {isOpen && !isLeaf
              ? childCollections(caps, node.kind).map((childKind) => (
                  <TreeLevel
                    key={childKind}
                    connectionId={connectionId}
                    caps={caps}
                    path={{ database: object.database, schema: object.schema, kind: childKind }}
                    depth={depth + 1}
                    parentObject={object}
                    onOpenTable={onOpenTable}
                    onOpenDDL={onOpenDDL}
                    expanded={expanded}
                    onToggle={onToggle}
                  />
                ))
              : null}
          </div>
        )
      })}
    </>
  )
}

function useDBTreeExpandedState() {
  return useState<ReadonlySet<string>>(new Set())
}

export function DBObjectTree({ connectionId, caps, onOpenTable, onOpenDDL }: DBObjectTreeProps) {
  const [expanded, setExpanded] = useDBTreeExpandedState()

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="overflow-auto py-1.5">
      {childCollections(caps, '').map((rootKind) => (
        <TreeLevel
          key={rootKind}
          connectionId={connectionId}
          caps={caps}
          path={{ database: '', schema: '', kind: rootKind }}
          depth={0}
          parentObject={{ database: '', schema: '', name: '', kind: '' }}
          onOpenTable={onOpenTable}
          onOpenDDL={onOpenDDL}
          expanded={expanded}
          onToggle={toggle}
        />
      ))}
    </div>
  )
}
