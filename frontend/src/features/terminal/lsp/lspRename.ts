import type { QueryClient } from '@tanstack/react-query'
import type { EditorView } from '@codemirror/view'
import { qk } from '@/features/data/keys'
import { fetchWorktreeFile, writeWorktreeFile } from '@/lib/machineApi'
import type { Machine } from '@/store/types'
import type { LspSession } from './lspSession'
import { offsetToPosition, positionToOffset } from '../lspExtensions'
import {
  applyTextEdits,
  splitWorkspaceEdit,
  type FileEdits,
  type LspPosition,
  type LspTextEdit,
} from './lspWorkspaceEdit'

export interface RenameSubject {
  symbol: string
  position: LspPosition
}

export interface RenamePlan {
  newName: string
  currentEdits: LspTextEdit[]
  otherFiles: FileEdits[]
}

/** Asks the server what may be renamed at `pos`, falling back to the word under
 *  the cursor when the server has no prepareRename provider. */
export async function prepareRename(
  view: EditorView,
  session: LspSession,
  path: string,
  pos: number,
): Promise<RenameSubject | null> {
  const position = offsetToPosition(view.state.doc, pos)
  const word = view.state.wordAt(pos)
  const fallback = word ? view.state.doc.sliceString(word.from, word.to) : ''

  try {
    const result = await session.client.textDocumentPrepareRename({
      textDocument: { uri: session.documentUri(path) },
      position,
    })
    if (result && 'placeholder' in result && result.placeholder) {
      return { symbol: result.placeholder, position }
    }
    if (result && 'start' in result) {
      const from = positionToOffset(view.state.doc, result.start)
      const to = positionToOffset(view.state.doc, result.end)
      return { symbol: view.state.doc.sliceString(from, to), position }
    }
  } catch {
    // Server has no prepareRename support, or refused. Fall through.
  }

  return fallback ? { symbol: fallback, position } : null
}

export async function buildRenamePlan(args: {
  session: LspSession
  path: string
  subject: RenameSubject
  newName: string
  /** Reports whether an open tab for `path` has unsaved changes. */
  isPathDirty: (path: string) => boolean
}): Promise<{ ok: true; plan: RenamePlan } | { ok: false; reason: string }> {
  const { session, path, subject, newName, isPathDirty } = args

  let edit
  try {
    edit = await session.client.textDocumentRename({
      textDocument: { uri: session.documentUri(path) },
      position: subject.position,
      newName,
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Rename failed' }
  }

  const split = splitWorkspaceEdit(edit, session.documentUri(path), session.pathFromUri)

  if (split.unsupportedOps.length > 0) {
    const ops = [...new Set(split.unsupportedOps)].join(', ')
    return { ok: false, reason: `This rename needs file ${ops} operations, which DevDeck cannot apply` }
  }
  if (split.outsideRoot.length > 0) {
    return {
      ok: false,
      reason: `This rename touches ${split.outsideRoot.length} file(s) outside this worktree`,
    }
  }
  if (split.currentEdits.length === 0 && split.otherFiles.length === 0) {
    return { ok: false, reason: 'The language server returned no changes for this symbol' }
  }

  // A disk write would silently discard an unsaved buffer, so refuse upfront.
  const dirty = split.otherFiles.map((file) => file.path).filter(isPathDirty)
  if (dirty.length > 0) {
    return { ok: false, reason: `Save ${dirty.join(', ')} before renaming — they have unsaved changes` }
  }

  return { ok: true, plan: { newName, currentEdits: split.currentEdits, otherFiles: split.otherFiles } }
}

/**
 * Applies the plan: the open document through the editor (so it stays unsaved
 * and undoable), every other file straight to disk. A failed write stops the
 * loop and reports what was already written rather than pretending the rename
 * was atomic.
 */
export async function applyRenamePlan(args: {
  view: EditorView
  plan: RenamePlan
  machine: Machine
  worktreeId: string
  queryClient: QueryClient
}): Promise<void> {
  const { view, plan, machine, worktreeId, queryClient } = args

  if (plan.currentEdits.length > 0) {
    const changes = plan.currentEdits
      .map((edit) => ({
        from: positionToOffset(view.state.doc, edit.range.start),
        to: positionToOffset(view.state.doc, edit.range.end),
        insert: edit.newText,
      }))
      .sort((a, b) => a.from - b.from)
    view.dispatch({ changes })
  }

  const written: string[] = []
  try {
    for (const file of plan.otherFiles) {
      const current = await fetchWorktreeFile(machine, worktreeId, file.path)
      const next = applyTextEdits(current.content, file.edits)
      await writeWorktreeFile(machine, worktreeId, { path: file.path, content: next })
      written.push(file.path)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'write failed'
    const partial = written.length > 0 ? ` Already written: ${written.join(', ')}.` : ''
    throw new Error(`Rename stopped after ${written.length} file(s): ${detail}.${partial}`)
  } finally {
    for (const path of written) {
      void queryClient.invalidateQueries({ queryKey: qk.worktreeFile(machine.id, worktreeId, path) })
    }
    if (written.length > 0) {
      void queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) })
    }
  }
}
