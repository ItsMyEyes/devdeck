import { useMemo, useState } from 'react'
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import type { Issue, IssueStatus, Project } from '@/store/types'
import { useCreateIssue, useUpdateIssue } from '@/features/data/queries'
import { IssueCardOverlay } from './IssueCard'
import { IssueColumn } from './IssueColumn'

const STATUSES: IssueStatus[] = ['todo', 'in_progress', 'in_review', 'done']

export function IssuesBoard({ project, wsId }: { project: Project; wsId: string }) {
  const createIssue = useCreateIssue()
  const updateIssue = useUpdateIssue()
  const [activeIssue, setActiveIssue] = useState<Issue | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const byStatus = useMemo(() => {
    const map: Record<IssueStatus, Issue[]> = { todo: [], in_progress: [], in_review: [], done: [] }
    for (const issue of project.issues) map[issue.status].push(issue)
    for (const status of STATUSES) map[status].sort((a, b) => a.position - b.position)
    return map
  }, [project.issues])

  function handleDragStart(event: DragStartEvent) {
    setActiveIssue(project.issues.find((i) => i.id === event.active.id) ?? null)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveIssue(null)
    const { active, over } = event
    if (!over) return

    const dragged = project.issues.find((i) => i.id === active.id)
    if (!dragged) return

    const overStatus = (STATUSES as string[]).includes(over.id as string)
      ? (over.id as IssueStatus)
      : project.issues.find((i) => i.id === over.id)?.status
    if (!overStatus) return

    const column = byStatus[overStatus].filter((i) => i.id !== dragged.id)
    const overIndex = column.findIndex((i) => i.id === over.id)
    const insertAt = overIndex === -1 ? column.length : overIndex

    const prev = column[insertAt - 1]
    const next = column[insertAt]
    const position = !prev && !next ? 0 : !prev ? next.position - 1 : !next ? prev.position + 1 : (prev.position + next.position) / 2

    if (overStatus === dragged.status && position === dragged.position) return

    updateIssue.mutate({ id: dragged.id, patch: { status: overStatus, position } })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {STATUSES.map((status) => (
          <IssueColumn
            key={status}
            status={status}
            issues={byStatus[status]}
            wsId={wsId}
            projectId={project.id}
            onAdd={(title) => createIssue.mutate({ projectId: project.id, body: { title, status } })}
          />
        ))}
      </div>
      <DragOverlay>{activeIssue ? <IssueCardOverlay issue={activeIssue} /> : null}</DragOverlay>
    </DndContext>
  )
}
