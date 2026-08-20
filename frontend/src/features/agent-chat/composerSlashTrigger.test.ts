/**
 * Plan D4 — the `/` slash trigger (`composerSlashTrigger.ts`).
 *
 * Three kinds of coverage, matching the design spec's Testing section and
 * D3/`composerMention.test.ts`'s own shape:
 *
 * 1. Unit, no DOM: `matchSlashCommands` over the static `BUILT_IN_COMMANDS`
 *    list, and `slashLineStartAllow` — the pure line-start rule — wired to a
 *    real (but DOM-free) `EditorState`, built the same way
 *    `composerMention.test.ts`'s `mentionAllow` tests do.
 * 2. One real-editor mount (`useEditor`/`EditorContent`): typing `/pl` opens
 *    the menu, clicking `/plan` calls the injected callback with `'plan'`
 *    and leaves no text behind (a command inserts no node — spec §2).
 *
 * `slashLineStartAllow` is deliberately stricter than `mentionAllow`/
 * `isMentionWordStart` — it only allows the trigger at true start-of-doc or
 * right after a literal `'\n'`, NOT after a plain space (spec §4's own
 * "fix the /plan thing" case must not open the menu). That is why this
 * file's `TestEditorHost`, unlike `composerMention.test.ts`'s, starts from
 * an empty document rather than pre-filled text: typing `/pl` straight into
 * an empty doc lands the `/` at position 0, genuine start-of-doc.
 */
import { createElement, useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { EditorState } from '@tiptap/pm/state'
import { Node, getSchema } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'

import type { InteractionMode } from '@/features/agent-chat/useAgentChatSocket'
import {
  BUILT_IN_COMMANDS,
  createComposerSlashTrigger,
  matchSlashCommands,
  slashLineStartAllow,
} from '@/features/agent-chat/composerSlashTrigger'

afterEach(cleanup)

describe('BUILT_IN_COMMANDS', () => {
  it('has exactly /plan and /build, mapped to the right InteractionMode', () => {
    expect(BUILT_IN_COMMANDS.map((c) => [c.id, c.mode])).toEqual([
      ['plan', 'plan'],
      ['build', 'default'],
    ])
  })
})

describe('matchSlashCommands', () => {
  it('returns both commands for an empty query', () => {
    expect(matchSlashCommands('').map((c) => c.id)).toEqual(['plan', 'build'])
  })

  it('matches /build on the "default" keyword (t3code muscle memory)', () => {
    expect(matchSlashCommands('default').map((c) => c.id)).toEqual(['build'])
  })

  it('matches on label substring', () => {
    expect(matchSlashCommands('pl').map((c) => c.id)).toEqual(['plan'])
  })
})

// Stand-ins for the real editor's Document/Text extensions (T5/D5's job) —
// the same minimal inline-only schema shape `composerMention.test.ts` and
// `composerNodes.test.ts` build.
const TestDocument = Node.create({ name: 'doc', topNode: true, content: 'inline*' })
const TestText = Node.create({ name: 'text', group: 'inline' })
const schema = getSchema([TestDocument, TestText])

describe('slashLineStartAllow', () => {
  it('fires at the very start of the document', () => {
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text('/')]) })
    expect(slashLineStartAllow({ state, range: { from: 0, to: 1 } })).toBe(true)
  })

  it('fires right after a literal newline (Shift+Enter continuation line)', () => {
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text('x\n/')]) })
    expect(slashLineStartAllow({ state, range: { from: 2, to: 3 } })).toBe(true)
  })

  it('does not fire mid-sentence, as in "fix the /plan thing"', () => {
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text('fix the /plan thing')]) })
    // '/' at index 8, preceded by a space — NOT start of line, so this must be false.
    expect(slashLineStartAllow({ state, range: { from: 8, to: 13 } })).toBe(false)
  })

  it('does not fire inside a URL path, as in "https://host/path"', () => {
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text('https://host/path')]) })
    // The '/' before "path" is at index 12 (text.lastIndexOf('/') === 12),
    // preceded by 't' — NOT start of line, so this must be false.
    expect(slashLineStartAllow({ state, range: { from: 12, to: 17 } })).toBe(false)
  })
})

// A node view's `ReactRenderer` only draws through the portal registry
// `@tiptap/react`'s own `EditorContent`/`useEditor` set up on the editor —
// mirrors `composerMention.test.ts`'s harness. `ref` is passed as a plain
// prop (React 19's "ref as a prop" for function components, no
// `forwardRef`) so the callback the extension dispatches through can be
// read back out of the test.
function TestEditorHost({
  ref,
  onEditor,
}: {
  ref: { current: (mode: InteractionMode) => void }
  onEditor: (editor: Editor) => void
}) {
  const editor = useEditor({
    extensions: [TestDocument, TestText, createComposerSlashTrigger(ref)],
    content: { type: 'doc', content: [] },
  })

  useEffect(() => {
    if (editor) onEditor(editor)
  }, [editor, onEditor])

  return createElement(EditorContent, { editor })
}

describe('typing / and selecting a command', () => {
  it('typing /pl and selecting /plan calls the callback with "plan" and inserts nothing', async () => {
    const onInteractionModeChange = vi.fn()
    const ref = { current: onInteractionModeChange }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { ref, onEditor: (e: Editor) => (editor = e) }))

    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('/pl')

    await waitFor(() => {
      expect(document.querySelector('[data-command-item="plan"]')).not.toBeNull()
    })

    fireEvent.click(document.querySelector('[data-command-item="plan"]') as HTMLButtonElement)

    await waitFor(() => expect(onInteractionModeChange).toHaveBeenCalledWith('plan'))
    // No node insertion — a command is an action, not a reference (spec §2).
    expect(editor!.getText()).toBe('')
  })

  it('typing /bu and selecting /build calls the callback with "default"', async () => {
    const onInteractionModeChange = vi.fn()
    const ref = { current: onInteractionModeChange }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { ref, onEditor: (e: Editor) => (editor = e) }))

    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('/bu')

    await waitFor(() => {
      expect(document.querySelector('[data-command-item="build"]')).not.toBeNull()
    })

    fireEvent.click(document.querySelector('[data-command-item="build"]') as HTMLButtonElement)

    await waitFor(() => expect(onInteractionModeChange).toHaveBeenCalledWith('default'))
    expect(editor!.getText()).toBe('')
  })

  it('/ typed mid-sentence never opens the menu (reuses the line-start rule)', async () => {
    const onInteractionModeChange = vi.fn()
    const ref = { current: onInteractionModeChange }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { ref, onEditor: (e: Editor) => (editor = e) }))

    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('fix the /plan thing')

    expect(document.querySelector('[data-command-item]')).toBeNull()
  })
})
