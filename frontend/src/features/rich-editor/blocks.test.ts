import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { BLOCK_COMMANDS, MARK_ACTIONS, matchBlockCommands } from './blocks'
import { createEditorExtensions } from './extensions'

/**
 * The "/" menu and the selection toolbar both drive the editor through these
 * definitions, so what they claim to insert and what they report as active
 * has to be true of the real schema — a typo in a command name is otherwise
 * a silently dead menu entry.
 */

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

function makeEditor(content = 'hello') {
  const editor = new Editor({
    extensions: createEditorExtensions(),
    content,
    contentType: 'markdown',
  })
  editors.push(editor)
  return editor
}

function byId(id: string) {
  const command = BLOCK_COMMANDS.find((entry) => entry.id === id)
  if (!command) throw new Error(`no block command ${id}`)
  return command
}

describe('block commands', () => {
  it.each([
    ['paragraph', 'hello'],
    ['h1', '# hello'],
    ['h2', '## hello'],
    ['h3', '### hello'],
    ['bulletList', '- hello'],
    ['orderedList', '1. hello'],
    ['taskList', '- [ ] hello'],
    ['blockquote', '> hello'],
    ['codeBlock', '```\nhello\n```'],
  ])('%s turns the current block into %j', (id, expected) => {
    const editor = makeEditor()
    byId(id).apply(editor.chain()).run()
    // Trimmed because applying a block leaves StarterKit's TrailingNode an
    // empty paragraph to serialize — the same trailing-newline noise that
    // NotionEditor's resync check is written to tolerate.
    expect(editor.getMarkdown().trimEnd()).toBe(expected)
  })

  // The selection toolbar lights its buttons from `isActive`, so every
  // command that claims one has to be honest about it. Commands that insert a
  // node rather than transform the current block (mermaid, divider) leave the
  // caret outside what they inserted and correctly declare none.
  it('reports itself active once applied', () => {
    for (const command of BLOCK_COMMANDS) {
      if (!command.isActive) continue
      const editor = makeEditor()
      command.apply(editor.chain()).run()
      expect(command.isActive(editor), `${command.id} should be active`).toBe(true)
    }
  })

  it('leaves inserting commands without a misleading active state', () => {
    expect(byId('mermaid').isActive).toBeUndefined()
    expect(byId('horizontalRule').isActive).toBeUndefined()
  })

  it('inserts a mermaid fence with starter content', () => {
    const editor = makeEditor('')
    byId('mermaid').apply(editor.chain()).run()
    expect(editor.getMarkdown()).toContain('```mermaid')
    expect(editor.getMarkdown()).toContain('graph TD')
  })

  it('inserts a table with a header row', () => {
    const editor = makeEditor('')
    byId('table').apply(editor.chain()).run()
    expect(editor.getMarkdown()).toContain('| --- | --- |')
  })

  it('inserts a horizontal rule', () => {
    const editor = makeEditor()
    byId('horizontalRule').apply(editor.chain()).run()
    expect(editor.getMarkdown()).toContain('---')
  })
})

describe('mark actions', () => {
  it.each([
    ['bold', '**hello**'],
    ['italic', '*hello*'],
    ['strike', '~~hello~~'],
    ['code', '`hello`'],
  ])('%s wraps the selection as %j', (id, expected) => {
    const action = MARK_ACTIONS.find((entry) => entry.id === id)!
    const editor = makeEditor()
    action.apply(editor.chain().selectAll()).run()
    expect(editor.getMarkdown()).toBe(expected)
    expect(action.isActive(editor)).toBe(true)
  })
})

describe('matchBlockCommands', () => {
  it('returns everything for an empty query', () => {
    expect(matchBlockCommands('')).toHaveLength(BLOCK_COMMANDS.length)
  })

  it('matches on the label, case-insensitively', () => {
    expect(matchBlockCommands('HEAD').map((c) => c.id)).toEqual(['h1', 'h2', 'h3'])
  })

  it('matches on keywords the label does not contain', () => {
    expect(matchBlockCommands('todo').map((c) => c.id)).toEqual(['taskList'])
    expect(matchBlockCommands('hr').map((c) => c.id)).toEqual(['horizontalRule'])
  })

  it('returns nothing for a query that matches nothing', () => {
    expect(matchBlockCommands('zzzz')).toEqual([])
  })
})
