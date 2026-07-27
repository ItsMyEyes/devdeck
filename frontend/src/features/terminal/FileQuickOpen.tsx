import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { FileSearch, Search, X } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { useFileSearchTarget } from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
import { MaterialFileIcon } from './MaterialFileIcon'
import { computeHighlight, type HighlightRange } from './fileMatchHighlight'
import type { FilesTarget } from './filesTarget'

interface FileQuickOpenProps {
  open: boolean
  target: FilesTarget
  onClose: () => void
  onOpenFile: (path: string) => void
}

function isDirectoryResult(path: string) {
  return path.endsWith('/')
}

function withoutDirectoryMarker(path: string) {
  return isDirectoryResult(path) ? path.slice(0, -1) : path
}

function basename(path: string) {
  const clean = withoutDirectoryMarker(path)
  return clean.split('/').pop() ?? clean
}

/** The parent-folder portion of a path, or '' for a root-level entry. */
function dirname(path: string) {
  const clean = withoutDirectoryMarker(path)
  const slash = clean.lastIndexOf('/')
  return slash < 0 ? '' : clean.slice(0, slash)
}

/** Renders `text` with the given ranges emphasised (VS Code match highlight). */
function HighlightedText({ text, ranges }: { text: string; ranges: HighlightRange[] }) {
  if (ranges.length === 0) return <>{text}</>
  const nodes: React.ReactNode[] = []
  let cursor = 0
  ranges.forEach(([start, end], i) => {
    if (start > cursor) nodes.push(text.slice(cursor, start))
    nodes.push(
      <span key={i} className="font-semibold text-devdeck-accent">
        {text.slice(start, end)}
      </span>,
    )
    cursor = end
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return <>{nodes}</>
}

export function FileQuickOpen({
  open,
  target,
  onClose,
  onOpenFile,
}: FileQuickOpenProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [pattern, setPattern] = useState('')
  const [selected, setSelected] = useState(0)
  const deferredPattern = useDeferredValue(pattern)
  const search = useFileSearchTarget(target, deferredPattern, open, { includeDirs: true })
  const results = search.data ?? []
  useNativeOverlayBlocker(open)

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
    if (isDirectoryResult(path)) {
      setPattern(path)
      setSelected(0)
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
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
        aria-label="Find file or folder"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[68vh] w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-devdeck-border-menu bg-devdeck-popover shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        <div className="flex h-12 flex-none items-center gap-2.5 border-b border-devdeck-border px-3">
          <Search size={15} className="flex-none text-devdeck-accent" />
          <input
            ref={inputRef}
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            onKeyDown={handleKeydown}
            aria-label="File or folder search"
            placeholder="Search files/folders: terminal file editor"
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-devdeck-fg outline-none placeholder:text-devdeck-dim"
          />
          <span className="flex-none rounded border border-devdeck-border-strong bg-devdeck-terminal px-1.5 py-0.5 font-mono text-[9.5px] text-devdeck-dim">
            {target.kind === 'ssh' ? 'SSH' : 'Projects · Paths'}
          </span>
          <span className="rounded border border-devdeck-border-strong bg-devdeck-terminal px-1.5 py-0.5 font-mono text-[9.5px] text-devdeck-dim">
            Fuzzy
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close file search"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-1.5">
          {search.isFetching ? (
            <div className="flex h-24 items-center justify-center">
              <DataLoading compact label="searching…" />
            </div>
          ) : search.error ? (
            <div className="flex h-24 items-center justify-center px-5 text-center font-mono text-[11px] text-devdeck-red-soft">
              {search.error instanceof ApiError ? search.error.message : 'File search failed'}
            </div>
          ) : results.length === 0 ? (
            <div className="flex h-24 flex-col items-center justify-center gap-2 text-devdeck-dim">
              <FileSearch size={20} />
              <span className="font-mono text-[11px]">No matching files or folders</span>
            </div>
          ) : (
            results.map((path, index) => {
              const isDir = isDirectoryResult(path)
              const name = basename(path)
              const folder = dirname(path)
              return (
                <button
                  key={path}
                  type="button"
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => choose(path)}
                  className={`flex h-9 w-full cursor-pointer items-center gap-2.5 px-3 text-left ${
                    index === selected ? 'bg-devdeck-accent-tint' : 'hover:bg-devdeck-hover-wash'
                  }`}
                >
                  <MaterialFileIcon name={name} isDir={isDir} size={17} />
                  <span className="max-w-[52%] flex-none truncate font-mono text-[12px] text-devdeck-fg">
                    <HighlightedText text={name} ranges={computeHighlight(name, deferredPattern)} />
                  </span>
                  {folder ? (
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-devdeck-dim">
                      <HighlightedText text={folder} ranges={computeHighlight(folder, deferredPattern)} />
                    </span>
                  ) : (
                    <span className="flex-1" />
                  )}
                  {isDir ? (
                    <span className="flex-none rounded border border-devdeck-border-strong px-1.5 py-0.5 font-mono text-[9px] text-devdeck-dim">
                      folder
                    </span>
                  ) : null}
                </button>
              )
            })
          )}
        </div>

        <div className="flex h-8 flex-none items-center gap-3 border-t border-devdeck-border bg-devdeck-surface px-3 font-mono text-[9.5px] text-devdeck-dim">
          <span>↑↓ select</span>
          <span>Enter open / narrow folder</span>
          <span>Esc close</span>
          <span className="ml-auto">Fuzzy path matching; regex still works</span>
        </div>
      </div>
    </div>
  )
}
