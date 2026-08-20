import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createEditorExtensions } from './extensions'

/**
 * The contract the whole WYSIWYG migration rests on: markdown parsed into the
 * editor and serialized back out must still say the same thing. Anything this
 * file does not cover is a construct the editor is free to rewrite — which is
 * exactly why `MarkdownFileEditor` keeps a raw Monaco mode.
 */

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

function trip(markdown: string): string {
  const editor = new Editor({
    extensions: createEditorExtensions(),
    content: markdown,
    contentType: 'markdown',
  })
  editors.push(editor)
  return editor.getMarkdown()
}

describe('markdown round trip', () => {
  it.each([
    ['a heading and prose', '# Title\n\nSome prose.'],
    ['nested bullets', '- one\n- two\n  - nested'],
    ['an ordered list', '1. one\n2. two'],
    ['task list state', '- [ ] todo\n- [x] done'],
    ['a blockquote', '> quoted line'],
    ['a fenced block with its language', '```ts\nconst a = 1\n```'],
    ['a mermaid fence', '```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```'],
    ['inline marks', 'This is **bold**, *italic*, ~~struck~~ and `code`.'],
    ['a link', 'See [docs](https://example.com).'],
    ['a horizontal rule', 'above\n\n---\n\nbelow'],
    ['an image', '![alt text](https://example.com/a.png)'],
    ['a hard break', 'line one  \nline two'],
    ['a task list nested in a bullet', '- parent\n  - [ ] child'],
  ])('preserves %s', (_label, source) => {
    expect(trip(source)).toBe(source)
  })

  it('preserves a GFM table, normalizing only its column padding', () => {
    expect(trip('| a | b |\n| --- | --- |\n| 1 | 2 |').trim()).toBe(
      '| a   | b   |\n| --- | --- |\n| 1   | 2   |',
    )
  })

  it('round-trips an empty document to an empty string', () => {
    expect(trip('')).toBe('')
  })

  // The normalizations below are accepted, not accidental: a WYSIWYG editor
  // re-serializes the whole document, so it can only emit one spelling of
  // each construct. They are the reason raw mode exists.
  it('normalizes `*` bullets to `-`', () => {
    expect(trip('* one\n* two')).toBe('- one\n- two')
  })

  it('drops raw HTML, which is why files containing it open in raw mode', () => {
    expect(trip('<details><summary>More</summary>\n\nHidden\n\n</details>')).not.toContain('<details>')
  })

  it('drops the source trailing newline', () => {
    expect(trip('# Title\n')).toBe('# Title')
  })

  // The pair above and below is why NotionEditor's resync check compares
  // trailing-newline-insensitively: the editor neither preserves nor
  // consistently omits them, so an exact match would misread its own output
  // coming back as an external change.
  it('keeps trailing blank lines as empty paragraphs', () => {
    expect(trip('# Title\n\n\n')).toBe('# Title\n\n')
  })

  it('is idempotent — a second pass changes nothing', () => {
    const source = '# Title\n\n* a\n* b\n\n> quote\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n'
    const once = trip(source)
    expect(trip(once)).toBe(once)
  })
})
