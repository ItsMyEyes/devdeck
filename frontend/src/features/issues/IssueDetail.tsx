import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronLeft, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { StatusDot } from '@/components/ui/status-dot'
import { fmtDate } from '@/lib/format'
import { ISSUE_STATUS, PRI } from '@/lib/constants'
import type { Issue, IssueStatus, Priority } from '@/store/types'
import { useDeleteIssue, useUpdateIssue } from '@/features/data/queries'
import { ActivitySection } from './ActivitySection'
import { AttachmentList } from './AttachmentList'
import { MarkdownEditor } from './MarkdownEditor'

const STATUS_OPTIONS = (Object.keys(ISSUE_STATUS) as IssueStatus[]).map((s) => ({
  value: s,
  label: ISSUE_STATUS[s].label,
}))

const PRI_OPTIONS = (Object.keys(PRI) as Priority[]).map((p) => ({ value: p, label: PRI[p].label }))

/** Label-left, value-right row used in the Properties/Details sidebar sections. */
function PropRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[68px] flex-none font-mono text-[11px] text-loom-dim">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  )
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-loom-dim-2">
        {title}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  )
}

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

  function goBack() {
    navigate({ to: '/w/$wsId/p/$projectId/issues', params: { wsId, projectId } })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 flex-none items-center gap-1 border-b border-loom-border px-3">
        <button
          type="button"
          onClick={goBack}
          aria-label="Back to issues"
          className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[11.5px] text-loom-muted-2 hover:bg-loom-hover-wash hover:text-loom-fg-2"
        >
          <ChevronLeft size={14} />
          Issues
        </button>
        <span className="min-w-0 flex-1 truncate px-1 text-[12px] text-loom-dim">{issue.title}</span>
        <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleteIssue.isPending}>
          <Trash2 size={13} />
          Delete
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-8 md:flex-row md:items-start md:gap-10 md:px-10">
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
              placeholder="Issue title…"
              className="h-auto w-full border-none bg-transparent px-0 py-0 text-2xl font-bold leading-snug tracking-tight text-loom-fg focus-visible:ring-0"
            />
            <MarkdownEditor
              value={description}
              onChange={setDescription}
              onBlur={saveDescription}
              placeholder="Describe the issue…"
              issueId={issue.id}
            />
            <AttachmentList issueId={issue.id} />
            <ActivitySection issueId={issue.id} />
          </div>

          <div className="w-full flex-none border-t border-loom-border pt-6 md:w-64 md:border-l md:border-t-0 md:pl-8 md:pt-0">
            <div className="flex flex-col gap-6">
              <SidebarSection title="Properties">
                <PropRow label="Status">
                  <StatusDot color={ISSUE_STATUS[issue.status].color} />
                  <Select
                    value={issue.status}
                    onValueChange={(v) => updateIssue.mutate({ id: issue.id, patch: { status: v as IssueStatus } })}
                    options={STATUS_OPTIONS}
                    aria-label="Status"
                  />
                </PropRow>
                <PropRow label="Priority">
                  <StatusDot color={PRI[issue.priority].color} />
                  <Select
                    value={issue.priority}
                    onValueChange={(v) => updateIssue.mutate({ id: issue.id, patch: { priority: v as Priority } })}
                    options={PRI_OPTIONS}
                    aria-label="Priority"
                  />
                </PropRow>
                <PropRow label="Assignee">
                  <Input
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    onBlur={saveAssignee}
                    placeholder="Unassigned"
                  />
                </PropRow>
              </SidebarSection>

              <SidebarSection title="Details">
                <PropRow label="Created">
                  <span className="text-[12px] text-loom-muted">{fmtDate(issue.createdAt)}</span>
                </PropRow>
                <PropRow label="Updated">
                  <span className="text-[12px] text-loom-muted">{fmtDate(issue.updatedAt)}</span>
                </PropRow>
              </SidebarSection>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
