import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { CaseSensitive, ChevronDown, ChevronRight, Download, FileSearch, Loader2, Regex, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { GrepMatch } from '@/lib/machineApi'
import { dismissRipgrepInstall, isRipgrepInstallDismissed, ripgrepInstallTargetId } from '@/lib/ripgrepInstallPrefs'
import { useContentSearchTarget, useInstallRipgrepTarget } from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { MaterialFileIcon } from './MaterialFileIcon'
import type { FilesTarget } from './filesTarget'

function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback
}

interface ContentSearchPanelProps {
  open: boolean
  target: FilesTarget
  onClose: () => void
  /** length is the number of characters to select starting at column — see
   *  matchSpan's doc comment for how it's derived. */
  onOpenMatch: (path: string, line: number, column: number, length: number) => void
}

interface FlatMatch {
  path: string
  match: GrepMatch
}

function basename(path: string) {
  return path.split('/').pop() ?? path
}

function dirname(path: string) {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function matchKey(path: string, match: GrepMatch) {
  return `${path}\u0000${match.line}\u0000${match.column}`
}

interface MatchSpan {
  start: number
  length: number
}

/**
 * Re-derives, client-side, exactly where `query` matched inside a result
 * line's text — used both to render the highlighted preview and to select
 * the precise match when the file opens (PlainCodeEditor's LineReveal / the
 * worktree side's LSP range reveal). The backend's `column` is a 1-based
 * anchor (0 when the engine can't report one — the `grep` fallback doesn't
 * emit columns at all), so this reruns the same query as a regex starting
 * at that anchor to recover both ends of the match. Best-effort: an
 * unparsable regex (mid-typing) or a query that no longer matches (a stale
 * response racing a fast retype) falls back to a zero-length span at the
 * anchor.
 */
function matchSpan(text: string, column: number, query: string, regexMode: boolean, caseSensitive: boolean): MatchSpan {
  const anchor = column > 0 ? column - 1 : 0
  if (!query) return { start: anchor, length: 0 }
  const source = regexMode ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    const re = new RegExp(source, caseSensitive ? 'g' : 'gi')
    re.lastIndex = anchor
    const atAnchor = re.exec(text)
    if (atAnchor && atAnchor.index === anchor) return { start: atAnchor.index, length: Math.max(atAnchor[0].length, 1) }
    re.lastIndex = 0
    const anywhere = re.exec(text)
    if (anywhere) return { start: anywhere.index, length: Math.max(anywhere[0].length, 1) }
  } catch {
    // invalid regex mid-typing — fall through to the plain anchor
  }
  return { start: anchor, length: 0 }
}

function HighlightedMatch({ text, span }: { text: string; span: MatchSpan }) {
  const end = Math.min(text.length, span.start + span.length)
  if (span.length <= 0 || span.start >= end) return <>{text}</>
  return (
    <>
      {text.slice(0, span.start)}
      <span className="rounded-sm bg-devdeck-accent/25 font-semibold text-devdeck-accent">{text.slice(span.start, end)}</span>
      {text.slice(end)}
    </>
  )
}

export function ContentSearchPanel({ open, target, onClose, onOpenMatch }: ContentSearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [regexMode, setRegexMode] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query)
  const pushNativeOverlayBlocker = useDevDeckStore((s) => s.pushNativeOverlayBlocker)
  const popNativeOverlayBlocker = useDevDeckStore((s) => s.popNativeOverlayBlocker)

  const search = useContentSearchTarget(target, deferredQuery, open, { regex: regexMode, caseSensitive })
  const result = search.data
  const installRipgrep = useInstallRipgrepTarget(target)
  const targetId = ripgrepInstallTargetId(target)
  const [dismissed, setDismissed] = useState(() => isRipgrepInstallDismissed(target))

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCollapsed(new Set())
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  // Re-reads the "don't ask again" flag whenever the panel is reopened or
  // switches to a different worktree/connection — targetId (not `target`
  // itself) is the dep since target is a fresh object literal every render
  // in ExpandedTerminal.tsx/SSHShellPane.tsx.
  useEffect(() => {
    if (!open) return
    setDismissed(isRipgrepInstallDismissed(target))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetId])

  // Same rationale as FileQuickOpen's identical effect: a Browser tile's
  // native webview always stacks above this dialog's z-index, so it has to
  // be told to get out of the way for as long as this is open.
  useEffect(() => {
    if (!open) return
    pushNativeOverlayBlocker()
    return () => popNativeOverlayBlocker()
  }, [open, pushNativeOverlayBlocker, popNativeOverlayBlocker])

  const flat = useMemo<FlatMatch[]>(() => {
    if (!result) return []
    const rows: FlatMatch[] = []
    for (const file of result.files) {
      if (collapsed.has(file.path)) continue
      for (const match of file.matches) rows.push({ path: file.path, match })
    }
    return rows
  }, [result, collapsed])

  // Jump selection to the first result whenever a fresh response arrives
  // (not on every collapse toggle — collapsing shouldn't relocate focus).
  useEffect(() => {
    setSelectedKey(flat[0] ? matchKey(flat[0].path, flat[0].match) : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  if (!open) return null

  function toggleCollapsed(path: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function choose(row: FlatMatch) {
    const span = matchSpan(row.match.text, row.match.column, deferredQuery, regexMode, caseSensitive)
    const column = row.match.column > 0 ? row.match.column : span.start + 1
    onOpenMatch(row.path, row.match.line, column, span.length)
    onClose()
  }

  function moveSelection(delta: number) {
    if (flat.length === 0) return
    const currentIndex = selectedKey ? flat.findIndex((row) => matchKey(row.path, row.match) === selectedKey) : -1
    const nextIndex = currentIndex < 0 ? 0 : Math.min(flat.length - 1, Math.max(0, currentIndex + delta))
    const next = flat[nextIndex]
    if (next) setSelectedKey(matchKey(next.path, next.match))
  }

  function handleInstall() {
    installRipgrep.mutate(undefined, {
      onSuccess: (installed) => toast.success(`ripgrep ${installed.version} installed`),
      onError: (error) => toast.error(errorMessage(error, 'Could not install ripgrep')),
    })
  }

  function handleUseGrep() {
    dismissRipgrepInstall(target)
    setDismissed(true)
  }

  function handleKeydown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSelection(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(-1)
    } else if (event.key === 'Enter') {
      const current = selectedKey ? flat.find((row) => matchKey(row.path, row.match) === selectedKey) : flat[0]
      if (current) {
        event.preventDefault()
        choose(current)
      }
    }
  }

  const trimmed = deferredQuery.trim()
  // `engine === 'grep'` (vs. the zero-value `''`) is the response's own
  // signal that a grep fallback genuinely works on this target — see
  // GrepResult's backend doc comment. There's no separate OS/platform field
  // on GrepResult or Machine to check instead; this is the real,
  // response-derived stand-in for design decision 5's "no grep fallback on
  // Windows" carve-out (an empty engine there means neither rg nor grep was
  // found, so offering "Use grep" would be a lie).
  const grepFallbackWorks = result?.engine === 'grep'
  const showInstallBanner = !!result && !result.rgAvailable && !dismissed
  const installBannerMessage = grepFallbackWorks
    ? "ripgrep isn't installed on this target — using grep instead."
    : "ripgrep isn't installed on this target and no grep fallback is available — content search is unavailable until ripgrep is installed."

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-[rgba(8,9,10,0.62)] px-4 pt-[10vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search in files"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[74vh] w-full max-w-[760px] flex-col overflow-hidden rounded-lg border border-devdeck-border-menu bg-devdeck-popover shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        <div className="flex h-12 flex-none items-center gap-2.5 border-b border-devdeck-border px-3">
          <Search size={15} className="flex-none text-devdeck-accent" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeydown}
            aria-label="Search file contents"
            placeholder="Search in files…"
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-devdeck-fg outline-none placeholder:text-devdeck-dim"
          />
          <button
            type="button"
            onClick={() => setRegexMode((v) => !v)}
            aria-pressed={regexMode}
            title="Use regular expression"
            className={cn(
              'flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
              regexMode && 'bg-devdeck-accent-tint text-devdeck-accent',
            )}
          >
            <Regex size={14} />
          </button>
          <button
            type="button"
            onClick={() => setCaseSensitive((v) => !v)}
            aria-pressed={caseSensitive}
            title="Match case"
            className={cn(
              'flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
              caseSensitive && 'bg-devdeck-accent-tint text-devdeck-accent',
            )}
          >
            <CaseSensitive size={16} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close content search"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
          >
            <X size={14} />
          </button>
        </div>

        {showInstallBanner ? (
          <div className="flex flex-none items-center gap-2 border-b border-devdeck-border bg-devdeck-surface-2 px-3 py-1.5">
            <span className="min-w-0 flex-1 font-mono text-[10.5px] text-devdeck-muted">{installBannerMessage}</span>
            <button
              type="button"
              onClick={handleInstall}
              disabled={installRipgrep.isPending}
              className="flex h-6 flex-none cursor-pointer items-center gap-1 rounded-md bg-devdeck-accent px-2 font-mono text-[10.5px] font-semibold text-devdeck-accent-ink hover:bg-devdeck-accent-hover disabled:cursor-wait disabled:opacity-60"
            >
              {installRipgrep.isPending ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
              {installRipgrep.isPending ? 'Installing…' : 'Install ripgrep'}
            </button>
            {grepFallbackWorks ? (
              <button
                type="button"
                onClick={handleUseGrep}
                className="h-6 flex-none cursor-pointer rounded-md border border-devdeck-border-strong px-2 font-mono text-[10.5px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash"
              >
                Use grep
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto py-1.5">
          {trimmed === '' ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-devdeck-dim">
              <FileSearch size={20} />
              <span className="font-mono text-[11px]">Type to search file contents</span>
            </div>
          ) : search.isFetching ? (
            <div className="flex h-32 items-center justify-center">
              <DataLoading compact label="searching…" />
            </div>
          ) : search.error ? (
            <div className="flex h-32 items-center justify-center px-5 text-center font-mono text-[11px] text-devdeck-red-soft">
              {search.error instanceof ApiError ? search.error.message : 'Content search failed'}
            </div>
          ) : !result || result.files.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-devdeck-dim">
              <FileSearch size={20} />
              <span className="font-mono text-[11px]">No matches</span>
            </div>
          ) : (
            result.files.map((file) => {
              const isCollapsed = collapsed.has(file.path)
              const folder = dirname(file.path)
              return (
                <div key={file.path}>
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(file.path)}
                    className="flex h-7 w-full cursor-pointer items-center gap-1.5 px-3 text-left hover:bg-devdeck-hover-wash"
                  >
                    {isCollapsed ? (
                      <ChevronRight size={12} className="flex-none text-devdeck-dim-3" />
                    ) : (
                      <ChevronDown size={12} className="flex-none text-devdeck-dim-3" />
                    )}
                    <MaterialFileIcon name={basename(file.path)} size={14} />
                    <span className="min-w-0 flex-none truncate font-mono text-[11px] text-devdeck-fg-2">{basename(file.path)}</span>
                    {folder ? <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-devdeck-dim">{folder}</span> : <span className="flex-1" />}
                    <span className="flex-none rounded border border-devdeck-border-strong px-1.5 py-0.5 font-mono text-[9px] text-devdeck-dim">
                      {file.matches.length}
                    </span>
                  </button>
                  {isCollapsed
                    ? null
                    : file.matches.map((match) => {
                        const key = matchKey(file.path, match)
                        const span = matchSpan(match.text, match.column, deferredQuery, regexMode, caseSensitive)
                        return (
                          <button
                            key={key}
                            type="button"
                            onMouseEnter={() => setSelectedKey(key)}
                            onClick={() => choose({ path: file.path, match })}
                            className={cn(
                              'flex h-7 w-full cursor-pointer items-center gap-2.5 pl-9 pr-3 text-left',
                              key === selectedKey ? 'bg-devdeck-accent-tint' : 'hover:bg-devdeck-hover-wash',
                            )}
                          >
                            <span className="w-10 flex-none truncate text-right font-mono text-[10px] text-devdeck-dim">{match.line}</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-devdeck-fg-2">
                              <HighlightedMatch text={match.text} span={span} />
                            </span>
                          </button>
                        )
                      })}
                </div>
              )
            })
          )}
        </div>

        <div className="flex h-8 flex-none items-center gap-3 border-t border-devdeck-border bg-devdeck-surface px-3 font-mono text-[9.5px] text-devdeck-dim">
          <span>↑↓ select</span>
          <span>Enter open at line</span>
          <span>Esc close</span>
          {result?.truncated ? (
            <span className="ml-auto text-devdeck-yellow">results truncated</span>
          ) : result ? (
            <span className="ml-auto">{result.files.length} file{result.files.length === 1 ? '' : 's'}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
