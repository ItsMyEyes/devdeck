import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { FileSearch, Loader2, Search, X } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { useWorktreeFileSearch } from '@/features/data/queries'
import { MaterialFileIcon } from './MaterialFileIcon'

interface FileQuickOpenProps {
  open: boolean
  worktreeId: string
  onClose: () => void
  onOpenFile: (path: string) => void
}

function basename(path: string) {
  return path.split('/').pop() ?? path
}

export function FileQuickOpen({
  open,
  worktreeId,
  onClose,
  onOpenFile,
}: FileQuickOpenProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [pattern, setPattern] = useState('')
  const [selected, setSelected] = useState(0)
  const deferredPattern = useDeferredValue(pattern)
  const search = useWorktreeFileSearch(worktreeId, deferredPattern, open)
  const results = search.data ?? []

  useEffect(() => {
    if (!open) return
    setPattern('')
    setSelected(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  useEffect(() => {
    setSelected(0)
  }, [deferredPattern])

  if (!open) return null

  function choose(path: string) {
    onOpenFile(path)
    onClose()
  }

  function handleKeydown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((current) => Math.min(current + 1, Math.max(0, results.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((current) => Math.max(0, current - 1))
    } else if (event.key === 'Enter' && results[selected]) {
      event.preventDefault()
      choose(results[selected])
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-[rgba(8,9,10,0.62)] px-4 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Find file by regular expression"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[68vh] w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-loom-border-menu bg-loom-popover shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        <div className="flex h-12 flex-none items-center gap-2.5 border-b border-loom-border px-3">
          <Search size={15} className="flex-none text-loom-accent" />
          <input
            ref={inputRef}
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            onKeyDown={handleKeydown}
            aria-label="File path regular expression"
            placeholder="Regex: ^src/.*\\.tsx$"
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-loom-fg outline-none placeholder:text-loom-dim"
          />
          <span className="rounded border border-loom-border-strong bg-loom-terminal px-1.5 py-0.5 font-mono text-[9.5px] text-loom-dim">
            RE2
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close file search"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-loom-dim hover:bg-loom-hover-wash hover:text-loom-fg"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-1.5">
          {search.isFetching ? (
            <div className="flex h-24 items-center justify-center text-loom-dim">
              <Loader2 size={17} className="animate-spin" />
            </div>
          ) : search.error ? (
            <div className="flex h-24 items-center justify-center px-5 text-center font-mono text-[11px] text-loom-red-soft">
              {search.error instanceof ApiError ? search.error.message : 'File search failed'}
            </div>
          ) : results.length === 0 ? (
            <div className="flex h-24 flex-col items-center justify-center gap-2 text-loom-dim">
              <FileSearch size={20} />
              <span className="font-mono text-[11px]">No matching files</span>
            </div>
          ) : (
            results.map((path, index) => (
              <button
                key={path}
                type="button"
                onMouseEnter={() => setSelected(index)}
                onClick={() => choose(path)}
                className={`flex h-9 w-full cursor-pointer items-center gap-2.5 px-3 text-left ${
                  index === selected ? 'bg-loom-accent-tint' : 'hover:bg-loom-hover-wash'
                }`}
              >
                <MaterialFileIcon name={basename(path)} size={17} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-loom-fg-2">
                  {path}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="flex h-8 flex-none items-center gap-3 border-t border-loom-border bg-loom-surface px-3 font-mono text-[9.5px] text-loom-dim">
          <span>↑↓ select</span>
          <span>Enter open</span>
          <span>Esc close</span>
          <span className="ml-auto">Regular expression path matching</span>
        </div>
      </div>
    </div>
  )
}
