import { formatDistanceToNow } from 'date-fns'
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { MemoryOperation } from '@/lib/api'
import { useMemoryOperations } from './useMemory'

/** task_type is Hindsight's own internal job name — not written for display.
 *  Known values seen live; an unrecognized one falls back to a humanized
 *  form of the raw string rather than a blank label. */
const TASK_LABEL: Record<string, string> = {
  retain: 'Extracting facts',
  batch_retain: 'Retaining memories',
  consolidation: 'Consolidating memory',
  consolidate: 'Consolidating memory',
  mental_model_refresh: 'Refreshing mental model',
  reflect: 'Reflecting',
  embedding: 'Generating embeddings',
  document_transfer: 'Transferring documents',
}

function taskLabel(taskType: string): string {
  return TASK_LABEL[taskType] ?? taskType.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

interface StatusVisual {
  Icon: LucideIcon
  color: string
  spin?: boolean
  label: string
}

function statusVisual(status: string): StatusVisual {
  switch (status) {
    case 'running':
      return { Icon: Loader2, color: 'var(--devdeck-blue, #5b8dee)', spin: true, label: 'running' }
    case 'done':
    case 'completed':
    case 'success':
      return { Icon: CheckCircle2, color: 'var(--devdeck-green, #56d58a)', label: 'done' }
    case 'failed':
    case 'error':
      return { Icon: XCircle, color: 'var(--devdeck-err, #f87171)', label: 'failed' }
    default:
      return { Icon: Clock, color: 'var(--devdeck-yellow, #e0c05c)', label: status || 'pending' }
  }
}

function OperationRow({ op }: { op: MemoryOperation }) {
  const [expanded, setExpanded] = useState(false)
  // Hindsight retries a failing extraction under the hood rather than
  // flipping status to "failed" right away — a live retain against a bad
  // LLM key sits at status="pending" with retry_count > 0 and a populated
  // error_message for several attempts before (if ever) it gives up. Show
  // the error whenever one is present, not only once status says "failed" —
  // otherwise an operator watching this panel sees "pending" forever with
  // no clue why it never finishes.
  const erroring = Boolean(op.error_message)
  const visual = erroring && op.status !== 'failed' && op.status !== 'error' ? statusVisual('failed') : statusVisual(op.status)

  return (
    <div className="flex flex-col gap-1 rounded-md px-2.5 py-2 transition-colors hover:bg-devdeck-hover-wash">
      <div className="flex items-center gap-2.5">
        <visual.Icon size={14} className={cn('flex-none', visual.spin && 'animate-spin')} style={{ color: visual.color }} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-devdeck-fg">
          {taskLabel(op.task_type)}
          {op.items_count > 1 && <span className="text-devdeck-fg-2"> · {op.items_count} items</span>}
        </span>
        {op.retry_count > 0 && (
          <span className="flex-none rounded bg-devdeck-hover-wash px-1.5 py-0.5 font-mono text-[9.5px] text-devdeck-fg-2">
            retry {op.retry_count}
          </span>
        )}
        <span className="flex-none font-mono text-[10px] text-devdeck-fg-2">
          {formatDistanceToNow(new Date(op.updated_at), { addSuffix: true })}
        </span>
      </div>
      {erroring && op.error_message && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-[22px] truncate text-left font-mono text-[10.5px] text-devdeck-err/90 hover:text-devdeck-err"
        >
          {expanded ? op.error_message : `${op.error_message.slice(0, 90)}${op.error_message.length > 90 ? '…' : ''}`}
        </button>
      )}
    </div>
  )
}

/**
 * "What is Hindsight doing right now" — pending/running/failed background
 * jobs (fact extraction, consolidation, mental-model refresh), the work an
 * operator otherwise has no visibility into once a retain call returns.
 * Polls itself faster while anything is active — see useMemoryOperations.
 */
export function MemoryOperations({ enabled }: { enabled: boolean }) {
  const ops = useMemoryOperations(enabled)
  if (!enabled || ops.isPending || ops.isError || ops.data.operations.length === 0) return null

  const active = ops.data.operations.filter((o) => o.status === 'pending' || o.status === 'running')

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-fg-2">Activity</h3>
        {active.length > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-devdeck-accent-tint px-2 py-0.5 font-mono text-[9.5px] text-devdeck-accent">
            <Loader2 size={9} className="animate-spin" />
            {active.length} in progress
          </span>
        )}
      </div>
      <div className="flex flex-col rounded-lg border border-devdeck-border-card bg-devdeck-card-wash/40 p-1">
        {ops.data.operations.map((op) => (
          <OperationRow key={op.id} op={op} />
        ))}
      </div>
    </section>
  )
}
