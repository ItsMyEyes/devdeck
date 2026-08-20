/**
 * The set of files one turn changed, derived from that turn's own tool calls.
 *
 * ── Why the tool calls and not a diff ──
 * The obvious source is a real diff of the workspace between the turn's start
 * and its end, and it is the wrong one HERE: a DevDeck thread is not
 * necessarily attached to a local git worktree at all. An SSH DevOps thread
 * edits files on a remote host through `WriteFile`, and a `git diff` of the
 * operator's laptop has nothing to say about it — the card would simply never
 * appear on the threads this feature was asked for.
 *
 * What every thread does have is the turn's own transcript. A tool call that
 * wrote a file is already an item in it, carrying the tool's name and its
 * arguments, so the changed-file list is a projection of data the timeline has
 * already reduced. No new event, no new backend, and it works identically for a
 * local agent and a remote one.
 *
 * The cost of that choice, stated plainly: there are no line counts. `+241 -0`
 * needs a diff, and a tool call records that a file was written, not how much
 * of it changed. The card renders the file list without the stat rather than
 * inventing one — see `ChangedFilesCard`.
 *
 * Everything here is pure and unit-tested; `ChangedFilesCard.tsx` is the
 * rendering, and `MessagesTimeline.tsx` decides where a turn's card goes.
 */
import type { ChatItem } from '@/features/agent-chat/types'

/** One file a turn touched. `tool` is the call that touched it, kept for the
 *  chip's tooltip — "which step wrote this" is the first question the list
 *  raises and the transcript above is a long way to scroll for it. */
export interface ChangedFile {
  path: string
  tool: string
}

/**
 * Tools whose successful completion means "a file now differs".
 *
 * An allowlist, not a blocklist, and deliberately so: this list's job is to be
 * WRONG-BUT-QUIET about tools it does not know rather than confidently list a
 * file that was only read. `Read`, `Grep`, `Glob` and `Bash` all carry a
 * `file_path`/`path` argument and none of them change anything, so keying off
 * "has a path argument" — the shape `toolSummary` uses — would report every
 * file the agent so much as looked at as changed.
 *
 * Compared case-insensitively against the tool's display name, because the same
 * capability is spelled differently per provider (`Write` for claude,
 * `write_file` for others, `WriteFile` for DevDeck's own SSH tool layer).
 */
const WRITING_TOOLS = new Set([
  'write',
  'writefile',
  'write_file',
  'edit',
  'editfile',
  'edit_file',
  'multiedit',
  'multi_edit',
  'str_replace',
  'str_replace_editor',
  'str_replace_based_edit_tool',
  'notebookedit',
  'notebook_edit',
  'applypatch',
  'apply_patch',
  'create_file',
  'update_file',
])

/** Argument names a writing tool puts its target path in, most specific first.
 *  Mirrors `adapter.ts`'s `SUMMARY_KEYS` in spirit — one ordered list, so a
 *  tool nobody has heard of still degrades to "something useful". */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'target_file']

function isWritingTool(toolName: string | undefined): boolean {
  if (!toolName) return false
  return WRITING_TOOLS.has(toolName.toLowerCase().replace(/[\s-]/g, ''))
    || WRITING_TOOLS.has(toolName.toLowerCase())
}

function pathOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  for (const key of PATH_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * The distinct files this run of items changed, in first-touched order.
 *
 * Only `status === 'done'` counts. A call still running has not written
 * anything yet, and one that FAILED did not write anything at all — listing
 * either would tell the operator a file changed when it did not, which is the
 * one error this card cannot afford: it is the thing they would go and review.
 *
 * Deduplicated by path, keeping the FIRST tool that touched it. A turn that
 * edits one file four times changed one file, and the card counts files.
 */
export function changedFilesOf(items: readonly ChatItem[]): ChangedFile[] {
  const seen = new Map<string, ChangedFile>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.status !== 'done') continue
    if (!isWritingTool(item.toolName)) continue
    const path = pathOf(item.input)
    if (path === undefined || seen.has(path)) continue
    seen.set(path, { path, tool: item.toolName ?? 'Tool' })
  }
  return [...seen.values()]
}

/** `scripts/migrate.sh` → `migrate.sh`. Handles both separators: an SSH thread
 *  reports POSIX paths and a Windows worktree reports backslashes, and the chip
 *  has room for a name, not a path. */
export function changedFileName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1)
}

/** The directory a file sits in, as the card groups by — `''` for a file at the
 *  root, which `summarizeScopes` renders as `root`. */
export function changedFileScope(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut <= 0 ? '' : path.slice(0, cut)
}

export interface ChangedFileScope {
  /** The directory, or `root`. */
  label: string
  fileCount: number
}

/**
 * `scripts 2 files · root 1 file` — the one line the collapsed card shows above
 * its chips, so "what did this turn touch" is answerable without expanding.
 *
 * Ordered by file count descending, then by label, so the busiest directory
 * leads. A stable tiebreak matters: this renders on every settled turn, and a
 * summary that reshuffles between renders reads as the file list changing.
 */
export function summarizeScopes(files: readonly ChangedFile[]): ChangedFileScope[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    const label = changedFileScope(file.path) || 'root'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([label, fileCount]) => ({ label, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount || a.label.localeCompare(b.label))
}

/** How many chips the collapsed card shows before it stops and offers
 *  `Show all N files`. Three fits one row at the SSH rail's width, which is the
 *  narrowest place this renders. */
export const CHANGED_FILE_PREVIEW_LIMIT = 3

export function previewFiles(files: readonly ChangedFile[]): ChangedFile[] {
  return files.slice(0, CHANGED_FILE_PREVIEW_LIMIT)
}
