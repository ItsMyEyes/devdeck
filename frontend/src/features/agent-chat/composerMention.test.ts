/**
 * Plan T4 — the `@` file/folder mention trigger (`composerMention.ts`).
 *
 * Three kinds of coverage, matching the design spec's Testing section:
 *
 * 1. Unit, no DOM: `isMentionWordStart` — the pure word-start rule — and
 *    `mentionAllow` — the same rule wired to a real (but DOM-free)
 *    `EditorState`, built the same way `composerNodes.test.ts` builds one
 *    (`getSchema` over a minimal inline-only doc/text pair).
 * 2. One real-editor mount (`useEditor`/`EditorContent`, per
 *    `composerNodes.test.ts`'s own note on why a bare `new Editor()` from
 *    `@tiptap/core` doesn't render node views): typing `@` calls
 *    `searchWorktreeFiles` (mocked, never a raw `fetch`) and renders the
 *    results; clicking one inserts a `composerFileChip` node and removes the
 *    `@query` text it replaced.
 */
import { createElement, useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { EditorState } from '@tiptap/pm/state'
import { Node, getSchema } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'

import type { Machine } from '@/store/types'
import { searchWorktreeFiles } from '@/lib/machineApi'

import { ComposerFileChip, ComposerSkillChip, ComposerTerminalContextChip } from '@/features/agent-chat/composerNodes'
import {
  createComposerMention,
  isMentionWordStart,
  mentionAllow,
  worktreeMentionSource,
} from '@/features/agent-chat/composerMention'

vi.mock('@/lib/machineApi', () => ({
  searchWorktreeFiles: vi.fn(),
}))

const searchWorktreeFilesMock = vi.mocked(searchWorktreeFiles)

const FAKE_MACHINE: Machine = {
  id: 'machine-1',
  name: 'local',
  url: 'http://localhost:8989',
  key: 'test-key',
  isLocal: true,
  signingPublicKey: 'pub',
}

afterEach(() => {
  cleanup()
  searchWorktreeFilesMock.mockReset()
})

describe('isMentionWordStart', () => {
  it('fires at the start of a word', () => {
    expect(isMentionWordStart('')).toBe(true)
    expect(isMentionWordStart(' ')).toBe(true)
    expect(isMentionWordStart('\n')).toBe(true)
  })

  it('does not fire mid-token, as inside a path like src/foo', () => {
    // The character right before `@` when it is typed straight after "foo"
    // in "src/foo@…" — not preceded by whitespace, so this must not open
    // the menu, exactly like a pasted path never opening `slashCommand.ts`'s
    // "/" menu mid-word.
    expect(isMentionWordStart('o')).toBe(false)
    expect(isMentionWordStart('/')).toBe(false)
  })

  it('does not fire inside an email address like a@b.com', () => {
    // The character right before `@` in "a@b.com" is "a".
    expect(isMentionWordStart('a')).toBe(false)
  })
})

// Stand-ins for the real editor's Document/Text extensions (T5's job) — the
// same minimal inline-only schema shape `composerNodes.test.ts` builds.
const TestDocument = Node.create({ name: 'doc', topNode: true, content: 'inline*' })
const TestText = Node.create({ name: 'text', group: 'inline' })
const schema = getSchema([TestDocument, TestText])

describe('mentionAllow', () => {
  it('allows the trigger at the very start of the document', () => {
    // doc: "@" — position 0 is the start of the doc, right before "@".
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text('@')]) })
    expect(mentionAllow({ state, range: { from: 0, to: 1 } })).toBe(true)
  })

  it('allows the trigger right after whitespace', () => {
    // doc: " @" — "@" starts at position 1, preceded by a space.
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text(' @')]) })
    expect(mentionAllow({ state, range: { from: 1, to: 2 } })).toBe(true)
  })

  it('does not allow the trigger mid-token, as in a pasted path', () => {
    // doc: "src/foo@" — "@" starts at position 7, preceded by "o".
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text('src/foo@')]) })
    expect(mentionAllow({ state, range: { from: 7, to: 8 } })).toBe(false)
  })

  it('does not allow the trigger inside an email address', () => {
    // doc: "a@" — "@" starts at position 1, preceded by "a".
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text('a@')]) })
    expect(mentionAllow({ state, range: { from: 1, to: 2 } })).toBe(false)
  })
})

// A node view's `ReactRenderer` only draws through the portal registry
// `@tiptap/react`'s own `EditorContent`/`useEditor` set up on the editor
// (`editor.contentComponent`) — a bare `new Editor(...)` from `@tiptap/core`
// never gets one. Mirrors `composerNodes.test.ts`'s harness.
function TestEditorHost({
  onEditor,
  debounceMs = 0,
}: {
  onEditor: (editor: Editor) => void
  debounceMs?: number
}) {
  const editor = useEditor({
    extensions: [
      TestDocument,
      TestText,
      ComposerFileChip,
      ComposerSkillChip,
      ComposerTerminalContextChip,
      createComposerMention(worktreeMentionSource(FAKE_MACHINE, 'worktree-1'), debounceMs),
    ],
    content: { type: 'doc', content: [{ type: 'text', text: 'hello ' }] },
  })

  useEffect(() => {
    if (editor) onEditor(editor)
  }, [editor, onEditor])

  return createElement(EditorContent, { editor })
}

describe('typing @ and selecting a result', () => {
  it('calls searchWorktreeFiles (never a raw fetch) through the typed helper', async () => {
    searchWorktreeFilesMock.mockResolvedValue(['src/app.tsx'])
    let capturedEditor: Editor | null = null
    render(createElement(TestEditorHost, { onEditor: (editor) => (capturedEditor = editor) }))

    await waitFor(() => expect(capturedEditor).not.toBeNull())
    capturedEditor!.commands.focus('end')
    capturedEditor!.commands.insertContent('@app')

    await waitFor(() => {
      expect(searchWorktreeFilesMock).toHaveBeenCalledWith(FAKE_MACHINE, 'worktree-1', 'app', { includeDirs: true })
    })
  })

  it('selecting a result inserts a composerFileChip and removes the @query text', async () => {
    searchWorktreeFilesMock.mockResolvedValue(['src/app.tsx', 'src/'])
    let capturedEditor: Editor | null = null
    const { container } = render(createElement(TestEditorHost, { onEditor: (editor) => (capturedEditor = editor) }))

    await waitFor(() => expect(capturedEditor).not.toBeNull())
    capturedEditor!.commands.focus('end')
    capturedEditor!.commands.insertContent('@app')

    await waitFor(() => {
      expect(container.ownerDocument.querySelector('[data-mention-item="src/app.tsx"]')).not.toBeNull()
    })

    fireEvent.click(document.querySelector('[data-mention-item="src/app.tsx"]') as HTMLButtonElement)

    await waitFor(() => {
      const content = capturedEditor!.getJSON().content ?? []
      expect(content.some((node) => node.type === 'composerFileChip' && node.attrs?.value === 'src/app.tsx')).toBe(true)
    })

    // The literal "@app" text the query occupied is gone — replaced by the
    // chip node, not left behind alongside it.
    expect(capturedEditor!.getText()).not.toContain('@app')
  })
})
