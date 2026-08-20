import { describe, expect, it } from 'vitest'
import { containsRawHtml, stripTrailingNewlines, trailingNewlines } from './markdownFile'

describe('containsRawHtml', () => {
  it.each([
    ['a details block', '# Readme\n\n<details>\n<summary>More</summary>\n</details>'],
    ['an img tag', '<img src="badge.svg" alt="build">'],
    ['a self-closing break', 'line one<br/>\nline two'],
    ['an indented tag', '  <div align="center">'],
    ['a closing tag alone on a line', 'text\n\n</div>'],
    ['an inline tag mid-sentence', 'Use the <kbd> element for keys.'],
  ])('flags %s', (_label, source) => {
    expect(containsRawHtml(source)).toBe(true)
  })

  it.each([
    ['plain prose', '# Title\n\nJust prose and a [link](https://example.com).'],
    ['html inside a fence', '```html\n<div>example</div>\n```'],
    ['html inside a tilde fence', '~~~\n<span>x</span>\n~~~'],
    ['html inside a long fence containing a short one', '````\n```\n<div>x</div>\n```\n````'],
    ['a generic inside a code span', 'Compare `Array<string>` values.'],
    ['a comparison operator', 'if a < b and b > c'],
    ['an autolink', 'Docs at <https://example.com> today.'],
    ['an email autolink', 'Mail <someone@example.com> about it.'],
  ])('leaves %s alone', (_label, source) => {
    expect(containsRawHtml(source)).toBe(false)
  })

  it('does not carry lastIndex state between calls', () => {
    const source = '<div>a</div>'
    expect(containsRawHtml(source)).toBe(true)
    expect(containsRawHtml(source)).toBe(true)
  })
})

describe('trailing newlines', () => {
  it.each([
    ['# Title\n', '# Title', '\n'],
    ['# Title\n\n\n', '# Title', '\n\n\n'],
    ['# Title', '# Title', ''],
    ['', '', '\n'],
    ['\n', '', '\n'],
  ])('splits %j into %j + %j', (body, stripped, trailer) => {
    expect(stripTrailingNewlines(body)).toBe(stripped)
    expect(trailingNewlines(body)).toBe(trailer)
  })

  it('keeps a file ending stable across an edit', () => {
    // What MarkdownFileEditor does: strip on the way in, re-attach on the way
    // out. Feeding the result back in has to produce the same split, or the
    // editor resyncs on every keystroke and the caret jumps.
    const body = '# Title\n'
    const edited = `${stripTrailingNewlines(body)} more${trailingNewlines(body)}`
    expect(edited).toBe('# Title more\n')
    expect(stripTrailingNewlines(edited)).toBe('# Title more')
    expect(trailingNewlines(edited)).toBe('\n')
  })
})
