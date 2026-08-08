import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useApplyDBDDL, useDBColumns, useDBDDLPreview, useDBIndexes } from '@/features/data/queries'
import type { DBColumnPlan, DBIndexPlan, DBObjectRef } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'

interface DBTableDesignerProps {
  connectionId: string
  /** null means "designing a new table" (kind: create); otherwise "alter". */
  object: DBObjectRef | null
  onApplied: (object: DBObjectRef) => void
}

function emptyColumn(): DBColumnPlan {
  return { name: '', dataType: '', nullable: true, default: null, isPrimaryKey: false }
}

export function DBTableDesigner({ connectionId, object, onApplied }: DBTableDesignerProps) {
  const isAlter = object !== null
  const { data: currentColumns } = useDBColumns(connectionId, object ?? { database: '', schema: '', name: '', kind: '' }, isAlter)
  const { data: currentIndexes } = useDBIndexes(connectionId, object ?? { database: '', schema: '', name: '', kind: '' }, isAlter)
  const [tableName, setTableName] = useState(object?.name ?? '')
  const [columns, setColumns] = useState<DBColumnPlan[]>([emptyColumn()])
  const [indexes, setIndexes] = useState<DBIndexPlan[]>([])
  const [preview, setPreview] = useState<string[] | null>(null)
  const previewMutation = useDBDDLPreview()
  const applyMutation = useApplyDBDDL()
  const showToast = useDevDeckStore((s) => s.showToast)

  useEffect(() => {
    if (isAlter && currentColumns) {
      setColumns(currentColumns.map((c) => ({ name: c.name, dataType: c.dataType, nullable: c.nullable, default: c.default, isPrimaryKey: c.isPrimaryKey })))
    }
    if (isAlter && currentIndexes) {
      setIndexes(currentIndexes.filter((i) => !i.primary).map((i) => ({ name: i.name, columns: i.columns, unique: i.unique })))
    }
  }, [isAlter, currentColumns, currentIndexes])

  const targetObject: DBObjectRef = { database: object?.database ?? '', schema: object?.schema ?? '', name: tableName.trim(), kind: 'table' }

  function updateColumn(i: number, patch: Partial<DBColumnPlan>) {
    setColumns((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }
  function addColumn() {
    setColumns((prev) => [...prev, emptyColumn()])
  }
  function removeColumn(i: number) {
    setColumns((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function runPreview() {
    setPreview(null)
    const plan = { object: targetObject, kind: isAlter ? ('alter' as const) : ('create' as const), columns, indexes }
    try {
      const result = await previewMutation.mutateAsync({ connectionId, plan })
      setPreview(result.statements)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to build preview')
    }
  }

  function apply() {
    const plan = { object: targetObject, kind: isAlter ? ('alter' as const) : ('create' as const), columns, indexes }
    applyMutation.mutate(
      { connectionId, plan },
      {
        onSuccess: () => { showToast(`Applied ${isAlter ? 'ALTER' : 'CREATE'} TABLE ${targetObject.name}`); onApplied(targetObject) },
        onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to apply DDL'),
      },
    )
  }

  const canApply = targetObject.name.length > 0 && columns.every((c) => c.name.trim() && c.dataType.trim())

  return (
    <div className="flex h-full flex-col overflow-auto p-3">
      {!isAlter ? (
        <>
          <Label>Table name</Label>
          <Input value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder="widgets" className="mb-3 font-mono" />
        </>
      ) : (
        <div className="mb-3 font-mono text-[13px] text-devdeck-fg">Altering {object!.name}</div>
      )}

      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-devdeck-fg-2">Columns</span>
        <Button variant="ghost" size="sm" onClick={addColumn}>
          <Plus size={12} />
          Add column
        </Button>
      </div>
      {columns.map((col, i) => (
        <div key={i} className="mb-1.5 flex items-center gap-1.5">
          <Input value={col.name} onChange={(e) => updateColumn(i, { name: e.target.value })} placeholder="name" className="w-36 font-mono text-[11.5px]" />
          <Input value={col.dataType} onChange={(e) => updateColumn(i, { dataType: e.target.value })} placeholder="text / integer / varchar(255)" className="flex-1 font-mono text-[11.5px]" />
          <label className="flex items-center gap-1 text-[10.5px] text-devdeck-fg-2">
            <input type="checkbox" checked={!col.nullable} onChange={(e) => updateColumn(i, { nullable: !e.target.checked })} />
            not null
          </label>
          <label className="flex items-center gap-1 text-[10.5px] text-devdeck-fg-2">
            <input type="checkbox" checked={col.isPrimaryKey} onChange={(e) => updateColumn(i, { isPrimaryKey: e.target.checked })} />
            PK
          </label>
          <Button variant="ghost" size="icon-sm" onClick={() => removeColumn(i)} aria-label="Remove column">
            <Trash2 size={12} />
          </Button>
        </div>
      ))}

      <div className="mt-4 flex items-center gap-2.5">
        <Button variant="secondary" size="sm" onClick={runPreview} disabled={!canApply || previewMutation.isPending}>
          Preview SQL
        </Button>
        <Button size="sm" onClick={apply} disabled={!canApply || applyMutation.isPending}>
          Apply
        </Button>
      </div>

      {preview ? (
        <pre className="mt-3 rounded-lg border border-devdeck-border-strong bg-devdeck-pane p-3 font-mono text-[11px] leading-relaxed text-devdeck-fg-2">
          {preview.join(';\n\n')};
        </pre>
      ) : null}
    </div>
  )
}
