import { useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import { Loader2, Paperclip } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { attachmentUrl } from '@/lib/api'
import { useUploadAttachment } from '@/features/data/queries'
import { cn } from '@/lib/utils'
import { MarkdownPreview } from './MarkdownPreview'
import { getCaretCoordinates } from './caretCoordinates'
import { SLASH_COMMANDS, TOOLBAR_ACTIONS, type SlashCommand } from './markdownCommands'

interface SlashMenuState {
  /** Index of the triggering "/" in the textarea value. */
  triggerStart: number
  query: string
  top: number
  left: number
  highlighted: number
}

/**
 * Click-to-edit markdown field: renders as plain document text on the page
 * canvas (no card/border/permanent toolbar) and swaps to a borderless
 * auto-growing textarea — with a formatting toolbar, "/" block-command menu,
 * and file attachment upload (button, drag-drop, or paste) — while focused.
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
  issueId: string
}) {
  const [editing, setEditing] = useState(false)
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const upload = useUploadAttachment()

  // Mirrors the latest `value` outside of React's render cycle, so an
  // in-flight attachment upload's onSuccess (which can resolve well after
  // the render that started it) always splices into current text instead of
  // reverting edits made while the upload was pending.
  const valueRef = useRef(value)
  valueRef.current = value

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!editing || !el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [editing, value])

  const filteredCommands = slashMenu
    ? SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(slashMenu.query.toLowerCase()))
    : []

  function insertAtCursor(text: string, cursorOffset: number, start?: number, end?: number) {
    const el = textareaRef.current
    const current = valueRef.current
    const from = start ?? el?.selectionStart ?? current.length
    const to = end ?? el?.selectionEnd ?? current.length
    onChange(current.slice(0, from) + text + current.slice(to))
    if (el) {
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(from + cursorOffset, from + cursorOffset)
      })
    } else {
      // Editing already ended (blur saved) before the upload/insert
      // finished — run the same save path the blur handler would have.
      onBlur?.()
    }
  }

  function insertAttachment(file: File) {
    upload.mutate(
      { issueId, file },
      {
        onSuccess: (att) => {
          const url = attachmentUrl(att.id)
          const markdown = att.mimeType.startsWith('image/')
            ? `![${att.filename}](${url})`
            : `[📎 ${att.filename}](${url})`
          insertAtCursor(markdown, markdown.length)
        },
      },
    )
  }

  function applyToolbarAction(apply: (value: string, start: number, end: number) => { value: string; selStart: number; selEnd: number }) {
    const el = textareaRef.current
    if (!el) return
    const result = apply(valueRef.current, el.selectionStart, el.selectionEnd)
    onChange(result.value)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(result.selStart, result.selEnd)
    })
  }

  function selectSlashCommand(cmd: SlashCommand) {
    const el = textareaRef.current
    if (!slashMenu || !el) return
    insertAtCursor(cmd.snippet, cmd.cursorOffset, slashMenu.triggerStart, el.selectionStart)
    setSlashMenu(null)
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const nextValue = e.target.value
    onChange(nextValue)

    const el = e.target
    const caret = el.selectionStart

    if (slashMenu) {
      if (caret <= slashMenu.triggerStart || nextValue[slashMenu.triggerStart] !== '/') {
        setSlashMenu(null)
        return
      }
      const query = nextValue.slice(slashMenu.triggerStart + 1, caret)
      setSlashMenu(/\s/.test(query) ? null : { ...slashMenu, query, highlighted: 0 })
      return
    }

    // Only trigger at the start of a line, like kiyowo's "/" composer commands.
    if (nextValue[caret - 1] === '/' && (caret < 2 || nextValue[caret - 2] === '\n')) {
      const coords = getCaretCoordinates(el, caret - 1)
      setSlashMenu({ triggerStart: caret - 1, query: '', top: coords.top + coords.height + 4, left: coords.left, highlighted: 0 })
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!slashMenu) return
    if (filteredCommands.length === 0 && e.key !== 'Escape') return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSlashMenu({ ...slashMenu, highlighted: (slashMenu.highlighted + 1) % filteredCommands.length })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSlashMenu({ ...slashMenu, highlighted: (slashMenu.highlighted - 1 + filteredCommands.length) % filteredCommands.length })
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      selectSlashCommand(filteredCommands[slashMenu.highlighted])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setSlashMenu(null)
    }
  }

  function handleDrop(e: DragEvent<HTMLTextAreaElement>) {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) insertAttachment(file)
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const file = Array.from(e.clipboardData.items)
      .find((item) => item.kind === 'file')
      ?.getAsFile()
    if (file) {
      e.preventDefault()
      insertAttachment(file)
    }
  }

  function handleFilePick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) insertAttachment(file)
    e.target.value = ''
  }

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setEditing(true)
          }
        }}
        className="-mx-1.5 cursor-text rounded-md px-1.5 py-1 transition-colors hover:bg-loom-hover-wash/40"
      >
        {value.trim() ? (
          <MarkdownPreview source={value} />
        ) : (
          <span className="text-[13px] text-loom-dim-2">{placeholder ?? 'Add a description…'}</span>
        )}
      </div>
    )
  }

  return (
    <div className="relative -mx-1.5 flex flex-col gap-2 rounded-md px-1.5">
      <div className="flex flex-wrap items-center gap-0.5 self-start rounded-lg border border-loom-border-strong bg-loom-popover/60 p-0.5">
        {TOOLBAR_ACTIONS.map((action) => (
          <Tooltip key={action.id} label={action.label}>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyToolbarAction(action.apply)}
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-loom-dim transition-colors hover:bg-loom-hover-wash hover:text-loom-fg-2"
            >
              <action.icon size={13} />
            </button>
          </Tooltip>
        ))}
        <span className="mx-0.5 h-4 w-px bg-loom-border-strong" />
        <Tooltip label="Attach file">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            disabled={upload.isPending}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-loom-dim transition-colors hover:bg-loom-hover-wash hover:text-loom-fg-2 disabled:opacity-50"
          >
            {upload.isPending ? <Loader2 size={13} className="animate-spin" /> : <Paperclip size={13} />}
          </button>
        </Tooltip>
      </div>
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFilePick} />

      <textarea
        ref={textareaRef}
        autoFocus
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onPaste={handlePaste}
        onBlur={() => {
          setSlashMenu(null)
          setEditing(false)
          onBlur?.()
        }}
        placeholder={placeholder}
        rows={1}
        className={cn(
          'w-full resize-none overflow-hidden rounded-md border-none bg-transparent px-0 py-0 text-[13px] leading-relaxed text-loom-fg-2',
          'font-sans placeholder:text-loom-dim-2 focus-visible:outline-none',
          isDragOver && 'outline-2 outline-dashed outline-loom-border-accent outline-offset-4',
        )}
      />

      {slashMenu && filteredCommands.length > 0 ? (
        <div
          className="absolute z-[70] flex w-56 flex-col gap-0.5 rounded-[11px] border border-loom-border-menu bg-loom-popover p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.55)]"
          style={{ top: slashMenu.top, left: slashMenu.left }}
        >
          {filteredCommands.map((cmd, i) => (
            <button
              key={cmd.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectSlashCommand(cmd)}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                i === slashMenu.highlighted ? 'bg-white/[0.05] text-loom-fg' : 'text-loom-fg-2 hover:bg-white/[0.05]',
              )}
            >
              <cmd.icon size={14} className="flex-none text-loom-dim" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12.5px]">{cmd.label}</span>
                <span className="truncate text-[10.5px] text-loom-dim">{cmd.hint}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
