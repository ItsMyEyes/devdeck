import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Loader2, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

/** Shared composer for both a new top-level comment and a reply — Cmd/Ctrl+Enter submits. */
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

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={2}
        autoFocus={autoFocus}
      />
      <div className="flex justify-end">
        <Button size="sm" onClick={handleSubmit} disabled={pending || !value.trim()}>
          {pending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}
