import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useNavigate } from '@tanstack/react-router'
import { Pill } from '@/components/ui/pill'
import { PRI } from '@/lib/constants'
import { cn } from '@/lib/utils'
import type { Issue } from '@/store/types'

const cardClass =
  'flex cursor-pointer flex-col gap-1.5 rounded-control border border-devdeck-border-card bg-devdeck-glass-solid px-2.5 py-2 text-left hover:border-devdeck-border-accent'

function CardBody({ issue }: { issue: Issue }) {
  const pri = PRI[issue.priority]
  return (
    <>
      <span className="line-clamp-2 text-[12.5px] leading-snug text-devdeck-fg">{issue.title}</span>
      <div className="flex items-center gap-1.5">
        <Pill color={pri.color}>{pri.label}</Pill>
        {issue.assignee ? (
          <span className="truncate font-mono text-[10.5px] text-devdeck-fg-2">{issue.assignee}</span>
        ) : null}
      </div>
    </>
  )
}

export function IssueCard({ issue, wsId, projectId }: { issue: Issue; wsId: string; projectId: string }) {
  const navigate = useNavigate()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: issue.id })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() =>
        navigate({
          to: '/w/$wsId/p/$projectId/issues/$issueId',
          params: { wsId, projectId, issueId: issue.id },
        })
      }
      className={cn(cardClass, isDragging && 'opacity-40')}
    >
      <CardBody issue={issue} />
    </div>
  )
}

/** Static visual clone rendered inside DragOverlay — deliberately has no drag listeners of its own. */
export function IssueCardOverlay({ issue }: { issue: Issue }) {
  return (
    <div className={cardClass}>
      <CardBody issue={issue} />
    </div>
  )
}
