import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { Loader2, Paperclip } from 'lucide-react'
import { attachmentUrl } from '@/lib/api'
import { useUploadAttachment } from '@/features/data/queries'
import { NotionEditor, type NotionEditorHandle } from '@/features/rich-editor/NotionEditor'
import { cn } from '@/lib/utils'

/**
 * The inline description field: a Notion-style WYSIWYG canvas that reads and
 * writes markdown, plus file attachment upload (button, drag-drop, or paste).
 *
 * Formatting lives in the editor itself — the selection toolbar and the "/"
 * block menu — which is why there's no toolbar strip here any more, and why
 * the old click-to-edit swap is gone: rendered *is* the editing surface now,
 * so there is no second state to switch into.
 *
 * Attachments are stored per issue, so the upload affordances only appear
 * when an `issueId` is provided; without one (e.g. the Tools page) the editor
 * is text-only.
 */
export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  placeholder,
  issueId,
}: {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  placeholder?: string
  issueId?: string
}) {
  const editorRef = useRef<NotionEditorHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const upload = useUploadAttachment()

  const onBlurRef = useRef(onBlur)
  onBlurRef.current = onBlur
  /** Set when an upload lands while the editor is unfocused: there is no blur
   *  left to trigger the caller's save, so one is fired from the effect below
   *  — after `value` has come back through the parent, so the save reads the
   *  text *with* the attachment in it rather than the stale draft. */
  const saveAfterInsert = useRef(false)

  useEffect(() => {
    if (!saveAfterInsert.current) return
    saveAfterInsert.current = false
    onBlurRef.current?.()
  }, [value])

  function insertAttachment(file: File) {
    if (!issueId) return
    upload.mutate(
      { issueId, file },
      {
        onSuccess: (attachment) => {
          const url = attachmentUrl(attachment.id)
          const markdown = attachment.mimeType.startsWith('image/')
            ? `![${attachment.filename}](${url})`
            : `[📎 ${attachment.filename}](${url})`
          saveAfterInsert.current = !editorRef.current?.isFocused()
          editorRef.current?.insertMarkdown(markdown)
        },
      },
    )
  }

  /** ProseMirror's own paste/drop hook: claims the event only when there is
   *  an issue to attach the file to, otherwise the editor handles it. */
  function handleFile(file: File) {
    if (!issueId) return false
    insertAttachment(file)
    return true
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    setIsDragOver(false)
    // ProseMirror preventDefaults the ones it claimed through `handleFile`;
    // this only catches a drop on the padding around the editable area.
    if (event.defaultPrevented || !issueId) return
    const file = event.dataTransfer.files[0]
    if (!file) return
    event.preventDefault()
    insertAttachment(file)
  }

  function handleFilePick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) insertAttachment(file)
    event.target.value = ''
  }

  return (
    <div
      className={cn(
        '-mx-1.5 rounded-md px-1.5',
        isDragOver && 'outline-2 outline-dashed outline-devdeck-border-accent outline-offset-4',
      )}
      onDragOver={(event) => {
        if (!issueId) return
        event.preventDefault()
        setIsDragOver(true)
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      <NotionEditor
        ref={editorRef}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        onFile={handleFile}
        placeholder={placeholder ?? 'Add a description…'}
        ariaLabel={placeholder ?? 'Description'}
        contentClassName="notion-doc--compact min-h-[1.6em] py-1"
      />

      {issueId ? (
        <>
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFilePick} />
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            disabled={upload.isPending}
            className="mt-1 flex h-6 cursor-pointer items-center gap-1.5 rounded px-1.5 text-[11px] text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg disabled:opacity-50"
          >
            {upload.isPending ? <Loader2 size={12} className="animate-spin" /> : <Paperclip size={12} />}
            {upload.isPending ? 'Uploading…' : 'Attach file'}
          </button>
        </>
      ) : null}
    </div>
  )
}
