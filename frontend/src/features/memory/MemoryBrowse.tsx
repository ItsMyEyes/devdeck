import { ChevronLeft, ChevronRight, Search, SearchX } from 'lucide-react'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/ui/pill'
import { Select } from '@/components/ui/select'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import type { MemoryUnit } from '@/lib/api'
import { useMemoryUnits } from './useMemory'

const TYPE_COLOR: Record<string, string> = {
  world: 'var(--devdeck-blue, #5b8dee)',
  experience: 'var(--devdeck-green, #56d58a)',
  observation: 'var(--devdeck-yellow, #e0c05c)',
}

const TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'world', label: 'World' },
  { value: 'experience', label: 'Experience' },
  { value: 'observation', label: 'Observation' },
]

function unitText(u: MemoryUnit): string {
  if (u.text) return u.text
  return typeof u.content === 'string' ? u.content : ''
}

function unitTimestamp(u: MemoryUnit): string | undefined {
  return u.mentioned_at ?? u.occurred_start ?? undefined
}

function MemoryCard({ unit }: { unit: MemoryUnit }) {
  const ts = unitTimestamp(unit)
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-devdeck-border-card bg-devdeck-card-wash/50 p-3.5 transition-colors hover:border-devdeck-border-accent/40">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-devdeck-fg">
          {unitText(unit) || <span className="italic text-devdeck-fg-2">(no text)</span>}
        </p>
        {unit.type && (
          <Pill color={TYPE_COLOR[unit.type] ?? 'var(--devdeck-fg-2, #888)'} className="flex-none">
            {unit.type}
          </Pill>
        )}
      </div>
      {(unit.tags ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {(unit.tags ?? []).map((tag) => (
            <span key={tag} className="rounded bg-devdeck-hover-wash px-1.5 py-0.5 font-mono text-[10px] text-devdeck-fg-2">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 font-mono text-[10px] text-devdeck-fg-2">
        {ts && <span>{new Date(ts).toLocaleString()}</span>}
        {unit.document_id && <span className="truncate">thread: {unit.document_id}</span>}
      </div>
    </div>
  )
}

export function MemoryBrowse() {
  const [query, setQuery] = useState('')
  const [type, setType] = useState<string>('')
  const [offset, setOffset] = useState(0)
  const units = useMemoryUnits(true, { q: query || undefined, type: type || undefined, offset })

  if (units.isPending) return <DataLoading label="loading memories…" />
  if (units.isError) return <DataError error={units.error} onRetry={() => units.refetch()} />

  const { items, total } = units.data

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex flex-none items-center gap-2">
        <div className="relative max-w-[320px] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-devdeck-fg-2" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setOffset(0)
            }}
            placeholder="Search retained memories…"
            className="pl-8"
          />
        </div>
        <Select
          value={type}
          onValueChange={(v) => {
            setType(v)
            setOffset(0)
          }}
          options={TYPE_OPTIONS}
          triggerClassName="w-[150px]"
          aria-label="Filter by type"
        />
        <span className="ml-auto font-mono text-[11px] text-devdeck-fg-2">{total} total</span>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <SearchX size={26} strokeWidth={1.5} className="text-devdeck-fg-2" />
          <p className="font-mono text-[12px] text-devdeck-fg-2">
            Nothing retained yet{query ? ' matching that search' : ''}.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {items.map((u) => (
            <MemoryCard key={u.id} unit={u} />
          ))}
        </div>
      )}

      <div className="flex flex-none items-center justify-between font-mono text-[11px] text-devdeck-fg-2">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 50))}
          className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-devdeck-hover-wash disabled:opacity-40"
        >
          <ChevronLeft size={13} />
          Prev
        </button>
        <span>
          {items.length > 0 ? `${offset + 1}–${offset + items.length}` : '0'} of {total}
        </span>
        <button
          type="button"
          disabled={offset + items.length >= total}
          onClick={() => setOffset(offset + 50)}
          className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-devdeck-hover-wash disabled:opacity-40"
        >
          Next
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  )
}
