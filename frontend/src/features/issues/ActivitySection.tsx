import { useMemo } from 'react'
import { Flag, GitCommitVertical, UserRound } from 'lucide-react'
import { ISSUE_STATUS, PRI } from '@/lib/constants'
import { fmtTimeAgo } from '@/lib/format'
import { useComments, useCreateComment, useIssueEvents } from '@/features/data/queries'
import type { IssueComment, IssueEvent, IssueStatus, Priority } from '@/store/types'
import { CommentComposer } from './CommentComposer'
import { CommentThread } from './CommentThread'

type TimelineItem =
  | { type: 'event'; key: string; createdAt: string; event: IssueEvent }
  | { type: 'comment'; key: string; createdAt: string; comment: IssueComment; replies: IssueComment[] }

/** Merges auto-recorded events and root comments into one chronological feed;
 *  replies stay grouped under their parent regardless of their own timestamp. */
function buildTimeline(events: IssueEvent[], comments: IssueComment[]): TimelineItem[] {
  const repliesByParent = new Map<string, IssueComment[]>()
  for (const c of comments) {
    if (!c.parentId) continue
    const list = repliesByParent.get(c.parentId) ?? []
    list.push(c)
    repliesByParent.set(c.parentId, list)
  }
  const items: TimelineItem[] = [
    ...events.map((event) => ({ type: 'event' as const, key: event.id, createdAt: event.createdAt, event })),
    ...comments
      .filter((c) => !c.parentId)
      .map((comment) => ({
        type: 'comment' as const,
        key: comment.id,
        createdAt: comment.createdAt,
        comment,
        replies: (repliesByParent.get(comment.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      })),
  ]
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function eventIcon(kind: IssueEvent['kind']) {
  switch (kind) {
    case 'priority_changed':
      return Flag
    case 'assignee_changed':
      return UserRound
    default:
      return GitCommitVertical
  }
}

function eventLabel(event: IssueEvent): string {
  switch (event.kind) {
    case 'status_changed':
      return `changed status to ${event.toValue ? (ISSUE_STATUS[event.toValue as IssueStatus]?.label ?? event.toValue) : '—'}`
    case 'priority_changed':
      return `changed priority to ${event.toValue ? (PRI[event.toValue as Priority]?.label ?? event.toValue) : '—'}`
    case 'assignee_changed':
      return event.toValue ? `assigned to ${event.toValue}` : 'unassigned the issue'
    default:
      return 'updated the issue'
  }
}

function TimelineEventRow({ event }: { event: IssueEvent }) {
  const Icon = eventIcon(event.kind)
  return (
    <div className="flex items-center gap-2 py-0.5 text-[11.5px] text-devdeck-dim">
      <Icon size={12} className="flex-none text-devdeck-dim-2" />
      <span className="min-w-0 flex-1 truncate">You {eventLabel(event)}</span>
      <span className="flex-none text-devdeck-dim-3">{fmtTimeAgo(event.createdAt)}</span>
    </div>
  )
}

/**
 * Activity feed for an issue: a chronological merge of auto-recorded
 * property-change events and the comment/reply thread, with a composer for
 * new top-level comments — mirroring kiyowo's issue-detail Activity tab.
 */
export function ActivitySection({ issueId }: { issueId: string }) {
  const { data: events, isLoading: eventsLoading } = useIssueEvents(issueId)
  const { data: comments, isLoading: commentsLoading } = useComments(issueId)
  const createComment = useCreateComment()

  const timeline = useMemo(() => buildTimeline(events ?? [], comments ?? []), [events, comments])
  const loading = eventsLoading || commentsLoading

  function submitComment(body: string) {
    createComment.mutate({ issueId, body: { author: 'You', body } })
  }

  return (
    <div className="flex flex-col gap-3 border-t border-devdeck-border pt-6">
      <div className="flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2">
        Activity
        {comments && comments.length > 0 ? <span className="text-devdeck-dim-3">{comments.length}</span> : null}
      </div>

      {loading ? (
        <p className="text-[12px] text-devdeck-dim">Loading activity…</p>
      ) : timeline.length === 0 ? (
        <p className="text-[12px] text-devdeck-dim-2">No activity yet — changes and comments will show up here.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {timeline.map((item) =>
            item.type === 'event' ? (
              <TimelineEventRow key={item.key} event={item.event} />
            ) : (
              <CommentThread key={item.key} issueId={issueId} comment={item.comment} replies={item.replies} />
            ),
          )}
        </div>
      )}

      <CommentComposer onSubmit={submitComment} pending={createComment.isPending} />
    </div>
  )
}
