import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ISSUE_STATUS } from '@/lib/constants'
import { cn } from '@/lib/utils'
import type { Issue, IssueStatus } from '@/store/types'
import { IssueCard } from './IssueCard'

export function IssueColumn({
  status,
  issues,
  wsId,
  projectId,
  onAdd,
}: {
  status: IssueStatus
  issues: Issue[]
  wsId: string
  projectId: string
  onAdd: (title: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const cfg = ISSUE_STATUS[status]

  function submit() {
    const t = title.trim()
    if (t) onAdd(t)
    setTitle('')
    setAdding(false)
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex w-72 flex-none flex-col rounded-container border border-devdeck-border-card bg-devdeck-pane/40 p-2',
        isOver && 'border-devdeck-border-accent',
      )}
    >
      <div className="flex items-center gap-2 px-1.5 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: cfg.color }} />
        <span className="font-mono text-[11.5px] font-semibold text-devdeck-fg">{cfg.label}</span>
        <span className="font-mono text-[11px] text-devdeck-fg-2">{issues.length}</span>
        <div className="min-w-2 flex-1" />
        <button
          type="button"
          onClick={() => setAdding(true)}
          aria-label="Add issue"
          className="cursor-pointer rounded-md p-1 text-devdeck-fg-2 hover:text-devdeck-fg-2"
        >
          <Plus size={14} />
        </button>
      </div>

      {adding ? (
        <div className="px-1.5 pb-1.5">
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') {
                setTitle('')
                setAdding(false)
              }
            }}
            onBlur={submit}
            placeholder="Issue title…"
          />
        </div>
      ) : null}

      <SortableContext items={issues.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-1.5 overflow-y-auto px-0.5 pb-1">
          {issues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} wsId={wsId} projectId={projectId} />
          ))}
          {issues.length === 0 && !adding ? (
            <div className="py-6 text-center font-mono text-[11px] text-devdeck-fg-2">no issues</div>
          ) : null}
        </div>
      </SortableContext>
    </div>
  )
}
