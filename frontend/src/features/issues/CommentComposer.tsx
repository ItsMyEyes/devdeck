import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Loader2, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NotionEditor } from '@/features/rich-editor/NotionEditor'

/** Shared composer for both a new top-level comment and a reply — Cmd/Ctrl+Enter submits.
 *
 *  Comment bodies are rendered as markdown (see CommentThread), so they are
 *  written on the same WYSIWYG canvas as issue descriptions rather than as raw
 *  syntax in a textarea. Cmd/Ctrl+Enter is caught on the wrapper: Tiptap binds
 *  neither combination, so the event reaches it unclaimed. */
export function CommentComposer({
  onSubmit,
  placeholder = 'Leave a comment…',
  submitLabel = 'Comment',
  autoFocus = false,
  pending = false,
}: {
  onSubmit: (body: string) => void
  placeholder?: string
  submitLabel?: string
  autoFocus?: boolean
  pending?: boolean
}) {
  const [value, setValue] = useState('')

  function handleSubmit() {
    const body = value.trim()
    if (!body || pending) return
    onSubmit(body)
    setValue('')
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        onKeyDown={handleKeyDown}
        // Box chrome stays on the DevDeck tokens — this is a field inside the
        // issues panel, not a page. Only the markdown inside it is themed.
        className="rounded-md border border-devdeck-border-strong bg-devdeck-pane px-3 py-2 transition-colors focus-within:border-devdeck-border-accent"
      >
        <NotionEditor
          value={value}
          onChange={setValue}
          placeholder={placeholder}
          ariaLabel={placeholder}
          autoFocus={autoFocus}
          contentClassName="notion-doc--compact min-h-[2.8em]"
        />
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={handleSubmit} disabled={pending || !value.trim()}>
          {pending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}
