import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { MaterialFileIcon } from './MaterialFileIcon'

export type DiffMode = 'split' | 'unified'

interface DiffViewProps {
  text: string
  mode: DiffMode
  /** Show the files-changed summary above the diff (used for commit patches). */
  showFileSummary?: boolean
}

interface DiffSide {
  no: number
  text: string
  changed: boolean
}

interface DiffRow {
  old: DiffSide | null
  new: DiffSide | null
}

interface DiffHunk {
  header: string
  rows: DiffRow[]
}

interface FileDiff {
  path: string
  oldPath: string
  binary: boolean
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

const META_PREFIXES = [
  'index ',
  '--- ',
  '+++ ',
  'new file',
  'deleted file',
  'old mode',
  'new mode',
  'similarity ',
  'dissimilarity ',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
]

function stripPrefix(path: string) {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2)
  return path
}

/** Parse a unified diff (possibly multi-file, possibly with a commit preamble). */
export function parseDiff(text: string): { preamble: string; files: FileDiff[] } {
  const lines = text.split('\n')
  const preamble: string[] = []
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let minusBuf: DiffSide[] = []
  let plusBuf: DiffSide[] = []

  function flushPairs() {
    const max = Math.max(minusBuf.length, plusBuf.length)
    for (let i = 0; i < max; i++) {
      hunk!.rows.push({ old: minusBuf[i] ?? null, new: plusBuf[i] ?? null })
    }
    minusBuf = []
    plusBuf = []
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (hunk) flushPairs()
      hunk = null
      // "diff --git a/old b/new" — take the b/ path (rename target).
      const parts = line.slice('diff --git '.length).split(' ')
      const oldPath = stripPrefix(parts[0] ?? '')
      const newPath = stripPrefix(parts[parts.length - 1] ?? '')
      file = {
        path: newPath === 'dev/null' || newPath === '/dev/null' ? oldPath : newPath,
        oldPath,
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      }
      files.push(file)
      continue
    }
    if (file === null) {
      preamble.push(line)
      continue
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.binary = true
      continue
    }
    if (line.startsWith('@@')) {
      if (hunk) flushPairs()
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (!match) continue
      oldNo = Number(match[1])
      newNo = Number(match[2])
      hunk = { header: line, rows: [] }
      file.hunks.push(hunk)
      continue
    }
    if (hunk === null) continue
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) continue
    if (line.startsWith('-')) {
      minusBuf.push({ no: oldNo++, text: line.slice(1), changed: true })
      file.deletions++
    } else if (line.startsWith('+')) {
      plusBuf.push({ no: newNo++, text: line.slice(1), changed: true })
      file.additions++
    } else if (line.startsWith(' ')) {
      flushPairs()
      const text = line.slice(1)
      hunk.rows.push({
        old: { no: oldNo++, text, changed: false },
        new: { no: newNo++, text, changed: false },
      })
    }
    // Anything else (blank separators between file sections) is not hunk content.
  }
  if (hunk) flushPairs()
  return { preamble: preamble.join('\n').trim(), files }
}

const ADDED_BG = 'rgba(86,213,138,0.07)'
const REMOVED_BG = 'rgba(248,113,113,0.07)'
const PAD_BG = 'rgba(255,255,255,0.015)'

export function DiffView({ text, mode, showFileSummary = false }: DiffViewProps) {
  const parsed = useMemo(() => parseDiff(text), [text])

  if (!text.trim()) {
    return (
      <div className="flex h-24 items-center justify-center font-mono text-[10.5px] text-devdeck-dim">
        No differences
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {parsed.preamble && (
        <pre className="whitespace-pre-wrap border-b border-devdeck-border px-4 py-3 font-mono text-[11px] leading-[1.6] text-devdeck-fg-2">
          {parsed.preamble}
        </pre>
      )}

      {showFileSummary && parsed.files.length > 0 && (
        <div className="border-b border-devdeck-border px-3 py-2">
          <div className="pb-1.5 font-mono text-[9.5px] tracking-[0.14em] text-devdeck-dim">
            {parsed.files.length} {parsed.files.length === 1 ? 'FILE' : 'FILES'} CHANGED
          </div>
          <div className="flex flex-col">
            {parsed.files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() =>
                  document
                    .getElementById(`diff-file-${file.path}`)
                    ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                }
                className="flex h-6 cursor-pointer items-center gap-1.5 rounded px-1.5 text-left hover:bg-devdeck-hover-wash"
              >
                <MaterialFileIcon name={file.path.split('/').pop() ?? file.path} size={13} />
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-devdeck-fg-2">{file.path}</span>
                <span className="flex-none font-mono text-[10px] text-devdeck-green">+{file.additions}</span>
                <span className="flex-none font-mono text-[10px] text-devdeck-red-soft">-{file.deletions}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {parsed.files.map((file) => (
        <div key={file.path} id={`diff-file-${file.path}`}>
          {(showFileSummary || parsed.files.length > 1) && (
            <div className="sticky top-0 z-10 flex h-7 items-center gap-1.5 border-b border-devdeck-border bg-devdeck-surface-2 px-3">
              <MaterialFileIcon name={file.path.split('/').pop() ?? file.path} size={13} />
              <span className="min-w-0 truncate font-mono text-[10.5px] text-devdeck-fg-2">
                {file.oldPath !== file.path && file.oldPath !== '/dev/null' && !file.oldPath.endsWith('dev/null')
                  ? `${file.oldPath} → ${file.path}`
                  : file.path}
              </span>
              <span className="flex-none font-mono text-[10px] text-devdeck-green">+{file.additions}</span>
              <span className="flex-none font-mono text-[10px] text-devdeck-red-soft">-{file.deletions}</span>
            </div>
          )}
          {file.binary ? (
            <div className="px-4 py-3 font-mono text-[10.5px] text-devdeck-dim">Binary file, no text diff</div>
          ) : mode === 'split' ? (
            <SplitFileDiff file={file} />
          ) : (
            <UnifiedFileDiff file={file} />
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Word-level highlight for a replaced line pair: the common prefix/suffix
 * stays on the line tint, the differing middle gets a stronger emphasis.
 * Returns null when the lines share nothing (whole-line change reads better).
 */
function intraline(oldText: string, newText: string): { old: [string, string, string]; new: [string, string, string] } | null {
  let prefix = 0
  const maxPrefix = Math.min(oldText.length, newText.length)
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++
  let suffix = 0
  while (
    suffix < maxPrefix - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  )
    suffix++
  if (prefix + suffix === 0) return null
  return {
    old: [oldText.slice(0, prefix), oldText.slice(prefix, oldText.length - suffix), oldText.slice(oldText.length - suffix)],
    new: [newText.slice(0, prefix), newText.slice(prefix, newText.length - suffix), newText.slice(newText.length - suffix)],
  }
}

const REMOVED_EMPHASIS = 'rgba(248,113,113,0.24)'
const ADDED_EMPHASIS = 'rgba(86,213,138,0.22)'

/** Wrapped line text with an optional emphasized middle segment. */
function LineText({ segments, text, emphasisBg }: { segments?: [string, string, string]; text: string; emphasisBg: string }) {
  return (
    <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] pr-3">
      {segments ? (
        <>
          {segments[0]}
          {segments[1] && (
            <span className="rounded-[2px]" style={{ background: emphasisBg }}>
              {segments[1]}
            </span>
          )}
          {segments[2]}
        </>
      ) : (
        text || ' '
      )}
    </span>
  )
}

function HunkHeader({ header }: { header: string }) {
  // "@@ -1,2 +1,3 @@ fn ctx" → range summary + optional trailing context.
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(header)
  return (
    <div className="flex items-center gap-2 border-y border-devdeck-border bg-devdeck-surface-2 px-3 py-1 font-mono text-[9.5px]">
      <span className="flex-none tracking-wide text-devdeck-dim">
        {match ? `−${match[1]},${match[2] ?? 1}  +${match[3]},${match[4] ?? 1}` : header}
      </span>
      {match?.[5] ? <span className="min-w-0 truncate text-devdeck-dim-2">{match[5]}</span> : null}
    </div>
  )
}

function SplitFileDiff({ file }: { file: FileDiff }) {
  return (
    <div className="font-mono text-[11px] leading-[1.6]">
      {file.hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex}>
          <HunkHeader header={hunk.header} />
          {hunk.rows.map((row, rowIndex) => {
            const pair =
              row.old?.changed && row.new?.changed ? intraline(row.old.text, row.new.text) : null
            return (
              <div key={rowIndex} className="grid grid-cols-2">
                <SplitCell side={row.old} removed segments={pair?.old} />
                <SplitCell side={row.new} removed={false} segments={pair?.new} />
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function SplitCell({
  side,
  removed,
  segments,
}: {
  side: DiffSide | null
  removed: boolean
  segments?: [string, string, string]
}) {
  if (side === null) {
    return <div style={{ background: PAD_BG }} className="border-r border-devdeck-border last:border-r-0" />
  }
  return (
    <div
      className={cn(
        'flex min-w-0 border-r border-devdeck-border last:border-r-0',
        side.changed ? (removed ? 'text-devdeck-red-soft' : 'text-devdeck-green') : 'text-devdeck-fg-2',
      )}
      style={side.changed ? { background: removed ? REMOVED_BG : ADDED_BG } : undefined}
    >
      <span className="w-10 flex-none select-none pr-2 pt-px text-right text-[10px] tabular-nums text-devdeck-dim-2">
        {side.no}
      </span>
      <LineText
        segments={side.changed ? segments : undefined}
        text={side.text}
        emphasisBg={removed ? REMOVED_EMPHASIS : ADDED_EMPHASIS}
      />
    </div>
  )
}

function UnifiedFileDiff({ file }: { file: FileDiff }) {
  return (
    <div className="font-mono text-[11px] leading-[1.6]">
      {file.hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex}>
          <HunkHeader header={hunk.header} />
          {hunk.rows.flatMap((row, rowIndex) => {
            const pair =
              row.old?.changed && row.new?.changed ? intraline(row.old.text, row.new.text) : null
            const cells: React.ReactNode[] = []
            if (row.old && row.old.changed)
              cells.push(<UnifiedLine key={`${rowIndex}o`} side={row.old} sign="-" segments={pair?.old} />)
            if (row.new && row.new.changed)
              cells.push(<UnifiedLine key={`${rowIndex}n`} side={row.new} sign="+" segments={pair?.new} />)
            if (row.old && !row.old.changed)
              cells.push(<UnifiedLine key={`${rowIndex}c`} side={row.old} sign=" " newNo={row.new?.no} />)
            return cells
          })}
        </div>
      ))}
    </div>
  )
}

function UnifiedLine({
  side,
  sign,
  newNo,
  segments,
}: {
  side: DiffSide
  sign: '-' | '+' | ' '
  newNo?: number
  segments?: [string, string, string]
}) {
  const color = sign === '-' ? 'text-devdeck-red-soft' : sign === '+' ? 'text-devdeck-green' : 'text-devdeck-fg-2'
  const bg = sign === '-' ? REMOVED_BG : sign === '+' ? ADDED_BG : undefined
  return (
    <div className={cn('flex', color)} style={bg ? { background: bg } : undefined}>
      <span className="w-9 flex-none select-none pr-1.5 pt-px text-right text-[10px] tabular-nums text-devdeck-dim-2">
        {sign === '+' ? '' : side.no}
      </span>
      <span className="w-9 flex-none select-none pr-2 pt-px text-right text-[10px] tabular-nums text-devdeck-dim-2">
        {sign === '-' ? '' : sign === '+' ? side.no : newNo}
      </span>
      <span className="w-4 flex-none select-none text-devdeck-dim">{sign}</span>
      <LineText
        segments={segments}
        text={side.text}
        emphasisBg={sign === '-' ? REMOVED_EMPHASIS : ADDED_EMPHASIS}
      />
    </div>
  )
}
