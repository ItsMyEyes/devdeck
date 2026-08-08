import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object'
}

function typeLabel(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) return `Array(${value.length})`
  return `Object(${Object.keys(value).length})`
}

function ScalarValue({ value }: { value: unknown }) {
  if (value === null) return <span className="text-devdeck-fg-2">null</span>
  if (typeof value === 'string') return <span className="break-all text-devdeck-run">"{value}"</span>
  if (typeof value === 'number') return <span className="text-devdeck-accent">{value}</span>
  if (typeof value === 'boolean') return <span className="text-devdeck-accent">{String(value)}</span>
  return <span className="text-devdeck-fg-2">undefined</span>
}

function JsonNode({ label, value, depth }: { label: string | null; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2)

  if (!isContainer(value)) {
    return (
      <div className="flex items-baseline gap-1.5 py-0.5 font-mono text-[11.5px]" style={{ paddingLeft: depth * 14 + 15 }}>
        {label !== null ? <span className="flex-none text-devdeck-fg-2">{label}:</span> : null}
        <ScalarValue value={value} />
      </div>
    )
  }

  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-1 py-0.5 font-mono text-[11.5px] hover:bg-white/[0.03]"
        style={{ paddingLeft: depth * 14 }}
      >
        <ChevronRight size={11} className={cn('flex-none text-devdeck-fg-2 transition-transform', open && 'rotate-90')} />
        {label !== null ? <span className="text-devdeck-fg-2">{label}:</span> : null}
        <span className="text-devdeck-fg-2">{typeLabel(value)}</span>
      </button>
      {open ? (
        entries.length ? (
          <div>
            {entries.map(([k, v]) => (
              <JsonNode key={k} label={k} value={v} depth={depth + 1} />
            ))}
          </div>
        ) : (
          <div className="py-0.5 font-mono text-[11px] text-devdeck-fg-2" style={{ paddingLeft: (depth + 1) * 14 + 15 }}>
            (empty)
          </div>
        )
      ) : null}
    </div>
  )
}

/** Collapsible tree explorer for a parsed JSON value — expands the first two levels by default. */
export function JsonTreeView({ value }: { value: unknown }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-devdeck-border-card bg-devdeck-pane p-2">
      <JsonNode label={null} value={value} depth={0} />
    </div>
  )
}
