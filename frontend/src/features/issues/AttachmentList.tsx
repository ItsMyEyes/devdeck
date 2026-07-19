import { useRef } from 'react'
import type { ChangeEvent } from 'react'
import { FileText, Loader2, Paperclip, Plus, Trash2 } from 'lucide-react'
import { attachmentUrl } from '@/lib/api'
import { fmtBytes } from '@/lib/format'
import { useAttachments, useDeleteAttachment, useUploadAttachment } from '@/features/data/queries'
import type { Attachment } from '@/store/types'

/**
 * Dedicated gallery view of everything uploaded to an issue — separate from
 * the inline markdown links the editor inserts into the description, so
 * files stay browsable even if their description reference gets edited away.
 * Always renders (even with zero attachments) so the Upload button is a
 * persistent entry point, not something hidden behind the description editor.
 */
export function AttachmentList({ issueId }: { issueId: string }) {
  const { data: attachments } = useAttachments(issueId)
  const deleteAttachment = useDeleteAttachment()
  const upload = useUploadAttachment()
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleFilePick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) upload.mutate({ issueId, file })
    e.target.value = ''
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2">
        <Paperclip size={11} />
        Attachments
        {attachments && attachments.length > 0 ? <span className="text-devdeck-dim-3">{attachments.length}</span> : null}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={upload.isPending}
          aria-label="Upload attachment"
          className="ml-0.5 flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 normal-case tracking-normal text-devdeck-dim transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2 disabled:opacity-50"
        >
          {upload.isPending ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
          Upload
        </button>
      </div>
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFilePick} />

      {attachments && attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2.5">
          {attachments.map((att) => (
            <AttachmentCard
              key={att.id}
              attachment={att}
              onDelete={() => deleteAttachment.mutate({ id: att.id, issueId })}
              deleting={deleteAttachment.isPending && deleteAttachment.variables?.id === att.id}
            />
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex w-full cursor-pointer items-center justify-center rounded-lg border border-dashed border-devdeck-border py-4 text-[12px] text-devdeck-dim-2 transition-colors hover:border-devdeck-border-strong hover:text-devdeck-dim"
        >
          No attachments yet — click to upload
        </button>
      )}
    </div>
  )
}

function AttachmentCard({
  attachment,
  onDelete,
  deleting,
}: {
  attachment: Attachment
  onDelete: () => void
  deleting: boolean
}) {
  const url = attachmentUrl(attachment.id)
  const isImage = attachment.mimeType.startsWith('image/')

  return (
    <div className="group relative flex w-36 flex-none flex-col overflow-hidden rounded-lg border border-devdeck-border bg-devdeck-card transition-colors hover:border-devdeck-border-strong">
      <a href={url} target="_blank" rel="noreferrer" className="block">
        {isImage ? (
          <div className="aspect-square w-full overflow-hidden bg-devdeck-surface-2">
            <img src={url} alt={attachment.filename} className="h-full w-full object-cover" loading="lazy" />
          </div>
        ) : (
          <div className="flex aspect-square w-full items-center justify-center bg-devdeck-surface-2">
            <FileText size={22} className="text-devdeck-dim" />
          </div>
        )}
      </a>
      <div className="flex min-w-0 flex-col gap-0.5 px-2 py-1.5">
        <span className="truncate text-[11.5px] text-devdeck-fg-2" title={attachment.filename}>
          {attachment.filename}
        </span>
        <span className="text-[10.5px] text-devdeck-dim">{fmtBytes(attachment.size)}</span>
      </div>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        aria-label={`Delete ${attachment.filename}`}
        className="absolute right-1.5 top-1.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded-md bg-black/60 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-devdeck-red-tint-strong hover:text-devdeck-red-soft focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-100"
      >
        {deleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
      </button>
    </div>
  )
}
