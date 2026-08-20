/**
 * `▸ 3 changed files · Show files` — what one turn wrote, under that turn.
 *
 * Adapted from t3code's `ChangedFilesTree.tsx`, with two deliberate departures.
 *
 * ── No diff stat ──
 * t3code's card leads with `+241 -0`, which it can because its changed-file
 * list comes out of a checkpointing subsystem that snapshots the workspace per
 * turn and really diffs it. DevDeck's comes from the turn's own tool calls (see
 * `changedFiles.ts` for why: an SSH thread's files are on a remote host, and no
 * local diff can see them). A tool call records THAT a file was written, not
 * how much of it changed, so there is no honest number to put there and the
 * card shows none rather than a plausible one.
 *
 * ── A flat list, not a tree ──
 * t3code renders a collapsible directory tree. This renders the scope summary
 * line plus chips, because the narrowest place this appears is the SSH rail at
 * ~440px, where a tree indents itself off the right edge after two levels. The
 * summary line (`scripts 2 files · root 1 file`) carries the grouping a tree
 * would have shown, in one line.
 */
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MaterialFileIcon } from '@/features/terminal/MaterialFileIcon'
import { changedFileName, previewFiles, summarizeScopes } from '@/features/agent-chat/changedFiles'
import type { ChangedFile } from '@/features/agent-chat/changedFiles'

export interface ChangedFilesCardProps {
  files: ChangedFile[]
  /** Opens one file. Optional: when a caller has nowhere to open a file — an
   *  SSH thread whose paths live on a remote host DevDeck has no editor for —
   *  the chips render as plain labels rather than as buttons that do nothing.
   *  A dead affordance is worse than no affordance. */
  onOpenFile?: (path: string) => void
}

export function ChangedFilesCard({ files, onOpenFile }: ChangedFilesCardProps) {
  const [expanded, setExpanded] = useState(false)
  if (files.length === 0) return null

  const scopes = summarizeScopes(files)
  const shown = expanded ? files : previewFiles(files)
  const hiddenCount = files.length - shown.length

  return (
    <div className="rounded-xl border border-devdeck-hairline bg-devdeck-raised p-1.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="group flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-devdeck-card"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('size-3.5 flex-none text-devdeck-dim-pane transition-transform', expanded && 'rotate-90')}
        />
        <span className="text-[12px] font-medium text-devdeck-fg">
          {files.length} changed file{files.length === 1 ? '' : 's'}
        </span>
        <span className="text-[11px] text-devdeck-dim-pane group-hover:text-devdeck-fg-2">
          {expanded ? 'Hide files' : 'Show files'}
        </span>
      </button>

      <div className="px-1.5 pt-1 pb-0.5">
        {/* `scripts 2 files · root 1 file` — the grouping a directory tree
            would have shown, on one line, because the narrowest surface this
            renders on has no room for a tree. */}
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-devdeck-dim-pane">
          {scopes.map((scope, index) => (
            <span key={scope.label} className="inline-flex items-center gap-1.5">
              {index > 0 ? <span aria-hidden="true">·</span> : null}
              <span className="font-mono text-devdeck-fg-2">{scope.label}</span>
              <span>
                {scope.fileCount} file{scope.fileCount === 1 ? '' : 's'}
              </span>
            </span>
          ))}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {shown.map((file) => (
            <FileChip key={file.path} file={file} onOpenFile={onOpenFile} />
          ))}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="rounded-md px-1.5 py-1 text-[11px] font-medium text-devdeck-dim-pane transition-colors hover:bg-devdeck-card hover:text-devdeck-fg"
            >
              Show all {files.length} files
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** One file. `title` carries the FULL path and the tool that wrote it — the
 *  chip shows a basename, and "which of the four `src/index.ts` is this, and
 *  what touched it" is the question that leaves. */
function FileChip({ file, onOpenFile }: { file: ChangedFile; onOpenFile?: (path: string) => void }) {
  const label = changedFileName(file.path)
  const title = `${file.path} · ${file.tool}`
  const content = (
    <>
      <MaterialFileIcon name={label} size={12} />
      <span className="truncate">{label}</span>
    </>
  )
  const shell =
    'inline-flex max-w-48 items-center gap-1 rounded-md border border-devdeck-hairline bg-devdeck-pane px-1.5 py-1 font-mono text-[10.5px] text-devdeck-fg-2'

  if (!onOpenFile) {
    return (
      <span className={shell} title={title}>
        {content}
      </span>
    )
  }
  return (
    <button
      type="button"
      title={title}
      onClick={() => onOpenFile(file.path)}
      className={cn(shell, 'transition-colors hover:bg-devdeck-card hover:text-devdeck-fg')}
    >
      {content}
    </button>
  )
}
