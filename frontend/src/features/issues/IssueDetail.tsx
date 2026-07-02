import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ISSUE_STATUS, PRI } from '@/lib/constants'
import type { Issue, IssueStatus, Priority } from '@/store/types'
import { useDeleteIssue, useUpdateIssue } from '@/features/data/queries'
import { MarkdownEditor } from './MarkdownEditor'

const STATUS_OPTIONS = (Object.keys(ISSUE_STATUS) as IssueStatus[]).map((s) => ({
  value: s,
  label: ISSUE_STATUS[s].label,
}))

const PRI_OPTIONS = (Object.keys(PRI) as Priority[]).map((p) => ({ value: p, label: PRI[p].label }))

export function IssueDetail({ issue, wsId, projectId }: { issue: Issue; wsId: string; projectId: string }) {
  const navigate = useNavigate()
  const updateIssue = useUpdateIssue()
  const deleteIssue = useDeleteIssue()

  const [title, setTitle] = useState(issue.title)
  const [description, setDescription] = useState(issue.description)
  const [assignee, setAssignee] = useState(issue.assignee ?? '')

  useEffect(() => {
    setTitle(issue.title)
    setDescription(issue.description)
    setAssignee(issue.assignee ?? '')
  }, [issue.id, issue.title, issue.description, issue.assignee])

  function saveTitle() {
    const t = title.trim()
    if (t && t !== issue.title) updateIssue.mutate({ id: issue.id, patch: { title: t } })
  }

  function saveDescription() {
    if (description !== issue.description) updateIssue.mutate({ id: issue.id, patch: { description } })
  }

  function saveAssignee() {
    const a = assignee.trim()
    if (a !== (issue.assignee ?? '')) updateIssue.mutate({ id: issue.id, patch: { assignee: a || null } })
  }

  function handleDelete() {
    deleteIssue.mutate(issue.id, {
      onSuccess: () => navigate({ to: '/w/$wsId/p/$projectId/issues', params: { wsId, projectId } }),
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
      <div className="flex items-start justify-between gap-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          className="flex-1 border-none bg-transparent px-0 text-[17px] font-semibold text-loom-fg focus-visible:ring-0"
        />
        <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleteIssue.isPending}>
          <Trash2 size={13} />
          Delete
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[150px]">
          <Select
            value={issue.status}
            onValueChange={(v) => updateIssue.mutate({ id: issue.id, patch: { status: v as IssueStatus } })}
            options={STATUS_OPTIONS}
            aria-label="Status"
          />
        </div>
        <div className="w-[118px]">
          <Select
            value={issue.priority}
            onValueChange={(v) => updateIssue.mutate({ id: issue.id, patch: { priority: v as Priority } })}
            options={PRI_OPTIONS}
            aria-label="Priority"
          />
        </div>
        <div className="w-[180px]">
          <Input
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            onBlur={saveAssignee}
            placeholder="Unassigned"
          />
        </div>
      </div>

      <MarkdownEditor
        value={description}
        onChange={setDescription}
        onBlur={saveDescription}
        placeholder="Describe the issue…"
      />
    </div>
  )
}
