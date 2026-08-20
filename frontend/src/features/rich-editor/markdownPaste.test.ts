import { describe, expect, it } from 'vitest'
import { looksLikeMarkdown } from './markdownPaste'

describe('looksLikeMarkdown', () => {
  it.each([
    ['a heading', '# Title'],
    ['a heading below prose', 'Intro line\n\n## Section'],
    ['a bullet list', '- one\n- two'],
    ['a task list', '- [ ] ship it'],
    ['a numbered list', '1. first\n2. second'],
    ['a quote', '> quoted'],
    ['a fence', '```ts\nconst a = 1\n```'],
    ['a table row', '| a | b |\n| --- | --- |'],
    ['multi-line bold', 'Line one\n**bold** line two'],
    ['a multi-line link', 'See here:\n[docs](https://example.com)'],
  ])('treats %s as markdown', (_label, text) => {
    expect(looksLikeMarkdown(text)).toBe(true)
  })

  it.each([
    ['empty text', ''],
    ['whitespace', '   \n  '],
    ['a bare sentence', 'Just some prose without any syntax.'],
    ['a single starred word', 'value * 2'],
    ['one line of bold', '**bold**'],
    ['a lone identifier', 'someFunction'],
  ])('leaves %s as plain text', (_label, text) => {
    expect(looksLikeMarkdown(text)).toBe(false)
  })
})
