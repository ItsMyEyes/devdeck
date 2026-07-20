import { Plus, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { DBColumnMeta, DBFilter } from '@/lib/api'

const OPS = [
  { value: 'eq', label: '=' },
  { value: 'ne', label: '≠' },
  { value: 'lt', label: '<' },
  { value: 'gt', label: '>' },
  { value: 'le', label: '≤' },
  { value: 'ge', label: '≥' },
  { value: 'like', label: 'contains' },
  { value: 'isnull', label: 'is null' },
  { value: 'isnotnull', label: 'is not null' },
]

const NO_VALUE_OPS = new Set(['isnull', 'isnotnull'])

interface DBFilterBarProps {
  columns: DBColumnMeta[]
  filters: DBFilter[]
  onFiltersChange: (filters: DBFilter[]) => void
  globalSearch: string
  onGlobalSearchChange: (value: string) => void
}

export function DBFilterBar({ columns, filters, onFiltersChange, globalSearch, onGlobalSearchChange }: DBFilterBarProps) {
  function addFilter() {
    const first = columns[0]
    if (!first) return
    onFiltersChange([...filters, { column: first.name, op: 'eq', values: [''] }])
  }
  function updateFilter(index: number, patch: Partial<DBFilter>) {
    onFiltersChange(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  }
  function removeFilter(index: number) {
    onFiltersChange(filters.filter((_, i) => i !== index))
  }

  const columnOptions = columns.map((c) => ({ value: c.name, label: c.name }))

  return (
    <div className="flex flex-none flex-col gap-1.5 border-b border-devdeck-border-menu px-3 py-2">
      <div className="flex items-center gap-2">
        <Search size={13} className="flex-none text-devdeck-dim" />
        <Input
          value={globalSearch}
          onChange={(e) => onGlobalSearchChange(e.target.value)}
          placeholder="Find in all columns (slow — sequential scan)…"
          className="h-7 font-mono text-[11.5px]"
        />
        <Button variant="ghost" size="sm" onClick={addFilter}>
          <Plus size={13} />
          Filter
        </Button>
      </div>
      {filters.map((f, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Select value={f.column} onValueChange={(v) => updateFilter(i, { column: v })} options={columnOptions} className="h-7 w-40" aria-label="Column" />
          <Select value={f.op} onValueChange={(v) => updateFilter(i, { op: v, values: NO_VALUE_OPS.has(v) ? [] : [''] })} options={OPS} className="h-7 w-32" aria-label="Operator" />
          {!NO_VALUE_OPS.has(f.op) ? (
            <Input
              value={String(f.values[0] ?? '')}
              onChange={(e) => updateFilter(i, { values: [e.target.value] })}
              className="h-7 flex-1 font-mono text-[11.5px]"
            />
          ) : (
            <div className="flex-1" />
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => removeFilter(i)} aria-label="Remove filter">
            <X size={12} />
          </Button>
        </div>
      ))}
    </div>
  )
}
