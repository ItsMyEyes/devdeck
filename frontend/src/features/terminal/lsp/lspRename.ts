import type { QueryClient } from '@tanstack/react-query'
import type { WorkspaceEdit } from 'vscode-languageserver-protocol'
import { qk } from '@/features/data/keys'
import { fetchWorktreeFile, writeWorktreeFile } from '@/lib/machineApi'
import type { Machine } from '@/store/types'
import type { LspSession } from './lspSession'
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
  session: LspSession,
  path: string,
  model: {
    getWordAtPosition(position: { lineNumber: number; column: number }):
      | { word: string; startColumn: number; endColumn: number }
      | null
  },
  position: { lineNumber: number; column: number },
): Promise<RenameSubject | null> {
  const word = model.getWordAtPosition(position)
  if (!word) return null
  // `textDocument/prepareRename` is optional; a server that does not implement
  // it errors, and the word under the cursor is a good enough subject.
  try {
    await session.transport.request('textDocument/prepareRename', {
      textDocument: { uri: session.documentUri(path) },
      position: { line: position.lineNumber - 1, character: position.column - 1 },
    })
  } catch {
    // fall through to the word-based subject
  }
  return {
    symbol: word.word,
    position: { line: position.lineNumber - 1, character: position.column - 1 },
  }
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

  let edit: WorkspaceEdit | null
  try {
    edit = await session.transport.request<WorkspaceEdit | null>('textDocument/rename', {
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

/** Structural subset of Monaco's `ITextModel` this module needs, kept local so
 *  the module — and its tests — stay free of monaco, which needs a real
 *  browser. */
interface EditableModel {
  pushEditOperations(
    beforeCursorState: null,
    editOperations: Array<{
      range: {
        startLineNumber: number
        startColumn: number
        endLineNumber: number
        endColumn: number
      }
      text: string
    }>,
    cursorStateComputer: () => null,
  ): unknown
}

/**
 * Applies the plan: the open document through the editor (so it stays unsaved
 * and undoable), every other file straight to disk. A failed write stops the
 * loop and reports what was already written rather than pretending the rename
 * was atomic.
 */
export async function applyRenamePlan(args: {
  model: EditableModel
  plan: RenamePlan
  machine: Machine
  worktreeId: string
  queryClient: QueryClient
}): Promise<void> {
  const { model, plan, machine, worktreeId, queryClient } = args

  if (plan.currentEdits.length > 0) {
    // Monaco coalesces these into one undo stop, so a rename is a single Ctrl-Z.
    model.pushEditOperations(
      null,
      plan.currentEdits.map((edit) => ({
        range: {
          startLineNumber: edit.range.start.line + 1,
          startColumn: edit.range.start.character + 1,
          endLineNumber: edit.range.end.line + 1,
          endColumn: edit.range.end.character + 1,
        },
        text: edit.newText,
      })),
      () => null,
    )
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
