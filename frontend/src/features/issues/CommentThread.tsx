import { useState } from 'react'
import { Loader2, Reply, Trash2 } from 'lucide-react'
import { fmtTimeAgo } from '@/lib/format'
import { useCreateComment, useDeleteComment } from '@/features/data/queries'
import type { IssueComment } from '@/store/types'
import { CommentComposer } from './CommentComposer'
import { MarkdownPreview } from './MarkdownPreview'

function CommentBubble({ comment, onDelete, deleting }: { comment: IssueComment; onDelete: () => void; deleting: boolean }) {
  return (
    <div className="group flex flex-col gap-1.5 rounded-lg border border-devdeck-border bg-devdeck-glass-solid px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-devdeck-fg-2">{comment.author}</span>
          <span className="text-[10.5px] text-devdeck-fg-2">{fmtTimeAgo(comment.createdAt)}</span>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          aria-label="Delete comment"
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-md text-devdeck-fg-2 opacity-0 transition-opacity hover:bg-devdeck-red-tint-strong hover:text-devdeck-err focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-100"
        >
          {deleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
        </button>
      </div>
      <MarkdownPreview source={comment.body} compact />
    </div>
  )
}

/** A root comment plus its single level of replies, with an inline reply composer. */
export function CommentThread({
  issueId,
  comment,
  replies,
}: {
  issueId: string
  comment: IssueComment
  replies: IssueComment[]
}) {
  const [replying, setReplying] = useState(false)
  const createComment = useCreateComment()
  const deleteComment = useDeleteComment()

  function submitReply(body: string) {
    createComment.mutate(
      { issueId, body: { author: 'You', body, parentId: comment.id } },
      { onSuccess: () => setReplying(false) },
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <CommentBubble
        comment={comment}
        onDelete={() => deleteComment.mutate({ id: comment.id, issueId })}
        deleting={deleteComment.isPending && deleteComment.variables?.id === comment.id}
      />

      {replies.length > 0 ? (
        <div className="ml-4 flex flex-col gap-2 border-l border-devdeck-border pl-3.5">
          {replies.map((reply) => (
            <CommentBubble
              key={reply.id}
              comment={reply}
              onDelete={() => deleteComment.mutate({ id: reply.id, issueId })}
              deleting={deleteComment.isPending && deleteComment.variables?.id === reply.id}
            />
          ))}
        </div>
      ) : null}

      <div className="ml-4 pl-3.5">
        {replying ? (
          <CommentComposer
            onSubmit={submitReply}
            placeholder="Write a reply…"
            submitLabel="Reply"
            autoFocus
            pending={createComment.isPending}
          />
        ) : (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2"
          >
            <Reply size={11} />
            Reply
          </button>
        )}
      </div>
    </div>
  )
}
