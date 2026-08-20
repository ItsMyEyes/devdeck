import { useMemo, useState } from 'react'
import { Sparkles, Users, Waypoints } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import type { MemoryGraphElement, MemoryGraphResponse } from '@/lib/api'
import { useMemoryEntityGraph, useMemoryGraph } from './useMemory'

// Hindsight's graph/entity-graph endpoints return Cytoscape.js "elements"
// JSON: every node/edge's real fields sit one level down, under `data`
// (verified live against a running server's
// /v1/default/banks/{bank}/graph and /entities/graph — curl output, not the
// OpenAPI schema; see internal/memory/client.go's package comment on why
// this repo trusts a live capture over the published docs). unwrap() peels
// that wrapper off; pick() then reads defensively from candidate keys so a
// server that changes its field names still renders something (id falls
// back to its own JSON, label falls back to the id) rather than
// disappearing silently.
function unwrap(el: MemoryGraphElement): MemoryGraphElement {
  const inner = el.data
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as MemoryGraphElement) : el
}

function pick(obj: MemoryGraphElement, candidates: string[]): string | undefined {
  for (const key of candidates) {
    const v = obj[key]
    if (typeof v === 'string' && v) return v
    if (typeof v === 'number') return String(v)
  }
  return undefined
}

const ID_KEYS = ['id', 'node_id', 'entity_id', 'memory_id']
const LABEL_KEYS = ['label', 'name', 'text', 'title']
const GROUP_KEYS = ['type', 'group', 'fact_type', 'entity_type', 'category']
const COLOR_KEYS = ['color']
const SOURCE_KEYS = ['source', 'from', 'source_id', 'from_id']
const TARGET_KEYS = ['target', 'to', 'target_id', 'to_id']
// linkType first: that's the real key Hindsight sends (cooccurrence,
// semantic, temporal, entity, caused_by), confirmed live — the rest are the
// defensive fallback the GROUP_KEYS-style guessing already used elsewhere.
const EDGE_LABEL_KEYS = ['linkType', 'label', 'type', 'relation', 'relation_type']

interface LayoutNode {
  id: string
  label: string
  group: string
  color?: string
  x: number
  y: number
  raw: MemoryGraphElement
}

interface LayoutEdge {
  source: string
  target: string
  label?: string
  color?: string
}

interface EdgeTypeLegend {
  label: string
  color: string
}

const GROUP_COLORS = [
  '#5b8dee', '#56d58a', '#e0c05c', '#e0715c', '#a26ce0', '#5cc9e0', '#e05ca7', '#8bd15c',
]

function colorFor(group: string, order: string[]): string {
  const idx = order.indexOf(group)
  return GROUP_COLORS[idx % GROUP_COLORS.length] ?? '#888'
}

function layout(
  data: MemoryGraphResponse,
  size: number,
): { nodes: LayoutNode[]; edges: LayoutEdge[]; groups: string[]; edgeTypes: EdgeTypeLegend[] } {
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 48
  const rawNodes = data.nodes ?? []
  const n = rawNodes.length || 1

  const nodes: LayoutNode[] = rawNodes.map((raw, i) => {
    const el = unwrap(raw)
    const id = pick(el, ID_KEYS) ?? `n${i}`
    const angle = (2 * Math.PI * i) / n - Math.PI / 2
    return {
      id,
      label: pick(el, LABEL_KEYS) ?? id,
      group: pick(el, GROUP_KEYS) ?? 'unknown',
      color: pick(el, COLOR_KEYS),
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
      raw,
    }
  })
  const nodeIds = new Set(nodes.map((n2) => n2.id))

  const edges: LayoutEdge[] = (data.edges ?? [])
    .map((raw) => {
      const el = unwrap(raw)
      return {
        source: pick(el, SOURCE_KEYS) ?? '',
        target: pick(el, TARGET_KEYS) ?? '',
        label: pick(el, EDGE_LABEL_KEYS),
        color: pick(el, COLOR_KEYS),
      }
    })
    .filter((e) => e.source && e.target && nodeIds.has(e.source) && nodeIds.has(e.target))

  // Node "type" has no real field in Hindsight's payload (verified live —
  // every node carries `color` but never `type`/`group`/etc.), so a single
  // 'unknown' bucket for every node is expected, not a parsing failure. It
  // stays out of `groups` — a legend with one row reading "unknown" told the
  // operator nothing. Edge relationships DO have a real, named field
  // (linkType), so those get their own legend instead.
  const groups = Array.from(new Set(nodes.map((n2) => n2.group))).filter((g) => g !== 'unknown').sort()
  const edgeTypes = Array.from(new Map(edges.filter((e) => e.label).map((e) => [e.label as string, e.color ?? '#8a8a8a'])))
    .map(([label, color]) => ({ label, color }))
    .sort((a, b) => a.label.localeCompare(b.label))

  return { nodes, edges, groups, edgeTypes }
}

const SIZE = 640

export function MemoryGraph() {
  const [mode, setMode] = useState<'facts' | 'entities'>('entities')
  const [selected, setSelected] = useState<LayoutNode | null>(null)
  const factsGraph = useMemoryGraph(mode === 'facts')
  const entityGraph = useMemoryEntityGraph(mode === 'entities')
  const q = mode === 'facts' ? factsGraph : entityGraph

  const built = useMemo(() => {
    if (!q.data) return null
    return layout(q.data, SIZE)
  }, [q.data])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex flex-none items-center gap-2">
        <Button variant={mode === 'entities' ? 'soft' : 'secondary'} size="sm" onClick={() => setMode('entities')} className="gap-1.5">
          <Users size={12} />
          Entities
        </Button>
        <Button variant={mode === 'facts' ? 'soft' : 'secondary'} size="sm" onClick={() => setMode('facts')} className="gap-1.5">
          <Sparkles size={12} />
          Facts
        </Button>
        {built && (
          <span className="ml-auto font-mono text-[11px] text-devdeck-fg-2">
            {built.nodes.length} node(s) · {built.edges.length} edge(s)
          </span>
        )}
      </div>

      {q.isPending && <DataLoading label="loading graph…" />}
      {q.isError && <DataError error={q.error} onRetry={() => q.refetch()} />}

      {built && built.nodes.length === 0 && !q.isPending && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <Waypoints size={26} strokeWidth={1.5} className="text-devdeck-fg-2" />
          <p className="font-mono text-[12px] text-devdeck-fg-2">No {mode} to graph yet — retain a few more memories first.</p>
        </div>
      )}

      {built && built.nodes.length > 0 && (
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="min-w-0 flex-1 overflow-auto rounded-lg border border-devdeck-border-card bg-devdeck-card-wash/30">
            <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} className="mx-auto">
              <g opacity={0.5}>
                {built.edges.map((e, i) => {
                  const s = built.nodes.find((n) => n.id === e.source)
                  const t = built.nodes.find((n) => n.id === e.target)
                  if (!s || !t) return null
                  return (
                    <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke={e.color ?? 'var(--devdeck-fg-2, #888)'} strokeWidth={1} />
                  )
                })}
              </g>
              {built.nodes.map((n) => {
                const isSelected = selected?.id === n.id
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x}, ${n.y})`}
                    className="cursor-pointer transition-transform hover:scale-110"
                    onClick={() => setSelected(n)}
                  >
                    <title>{n.label}</title>
                    <circle
                      r={isSelected ? 8 : 5.5}
                      fill={n.color ?? colorFor(n.group, built.groups)}
                      stroke={isSelected ? 'var(--devdeck-fg, #fff)' : 'none'}
                      strokeWidth={2}
                      className="transition-all"
                    />
                    <text
                      x={0}
                      y={-10}
                      textAnchor="middle"
                      className="pointer-events-none select-none"
                      style={{ fontSize: 9, fill: 'var(--devdeck-fg-2, #999)', fontFamily: 'monospace' }}
                    >
                      {n.label.length > 22 ? n.label.slice(0, 22) + '…' : n.label}
                    </text>
                  </g>
                )
              })}
            </svg>
          </div>

          <div className="w-[260px] flex-none overflow-y-auto rounded-lg border border-devdeck-border-card bg-devdeck-card-wash/50 p-3">
            {!selected ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <Waypoints size={20} strokeWidth={1.5} className="text-devdeck-fg-2" />
                <p className="font-mono text-[11px] text-devdeck-fg-2">Click a node to inspect it.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="text-[12.5px] font-semibold text-devdeck-fg">{selected.label}</div>
                <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-devdeck-fg-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: selected.color ?? colorFor(selected.group, built.groups) }}
                  />
                  {selected.group}
                </div>
                <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-devdeck-pane p-2 font-mono text-[10px] text-devdeck-fg-2">
                  {JSON.stringify(selected.raw, null, 2)}
                </pre>
              </div>
            )}
            {built.groups.length > 0 && (
              <div className="mt-4 flex flex-col gap-1.5 border-t border-devdeck-border pt-3">
                <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Legend</span>
                {built.groups.map((g) => (
                  <div key={g} className="flex items-center gap-1.5 font-mono text-[10.5px] text-devdeck-fg-2">
                    <span
                      className="inline-block h-2 w-2 flex-none rounded-full"
                      style={{ background: colorFor(g, built.groups) }}
                    />
                    <span className="truncate">{g}</span>
                  </div>
                ))}
              </div>
            )}
            {built.edgeTypes.length > 0 && (
              <div className="mt-4 flex flex-col gap-1.5 border-t border-devdeck-border pt-3">
                <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Edge types</span>
                {built.edgeTypes.map((et) => (
                  <div key={et.label} className="flex items-center gap-1.5 font-mono text-[10.5px] text-devdeck-fg-2">
                    <span className="inline-block h-2 w-2 flex-none rounded-full" style={{ background: et.color }} />
                    <span className="truncate">{et.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
