import { describe, expect, it } from 'vitest'
import {
  composerFileChip,
  composerSkillChip,
  composerTerminalContextChip,
  composerText,
  emptyComposerDoc,
  parseComposerText,
  serializeComposerDoc,
} from '@/features/agent-chat/composerSerialize'
import type { ComposerDoc } from '@/features/agent-chat/composerSerialize'

function doc(...content: ComposerDoc['content']): ComposerDoc {
  return { type: 'doc', content }
}

describe('serializeComposerDoc', () => {
  it('serializes an empty document to an empty string', () => {
    expect(serializeComposerDoc(emptyComposerDoc())).toBe('')
  })

  it('serializes a text-only document verbatim', () => {
    expect(serializeComposerDoc(doc(composerText('fix the login bug')))).toBe('fix the login bug')
  })

  it('serializes a file chip for src/app.tsx to a markdown link', () => {
    expect(serializeComposerDoc(doc(composerFileChip('src/app.tsx')))).toBe('[app.tsx](src/app.tsx)')
  })

  it('serializes a chip at the start of the document', () => {
    const result = serializeComposerDoc(doc(composerFileChip('src/app.tsx'), composerText(' please review')))
    expect(result).toBe('[app.tsx](src/app.tsx) please review')
  })

  it('serializes a chip at the end of the document', () => {
    const result = serializeComposerDoc(doc(composerText('please review '), composerFileChip('src/app.tsx')))
    expect(result).toBe('please review [app.tsx](src/app.tsx)')
  })

  it('serializes a chip between words', () => {
    const result = serializeComposerDoc(
      doc(composerText('look at '), composerFileChip('src/app.tsx'), composerText(' before merging')),
    )
    expect(result).toBe('look at [app.tsx](src/app.tsx) before merging')
  })

  // The whole point of the bracketed form. Under the `@path` scheme this
  // produced `@src/app.tsx@src/other.tsx` — one unparseable token, asserted at
  // the time as if it were correct.
  it('keeps two adjacent chips separately readable', () => {
    const result = serializeComposerDoc(doc(composerFileChip('src/app.tsx'), composerFileChip('src/other.tsx')))
    expect(result).toBe('[app.tsx](src/app.tsx)[other.tsx](src/other.tsx)')
  })

  // Same defect, the common case: a user typing straight after a mention.
  it('does not let a chip swallow the word that follows it', () => {
    const result = serializeComposerDoc(doc(composerFileChip('src/app.tsx'), composerText('please review')))
    expect(result).toBe('[app.tsx](src/app.tsx)please review')
  })

  it('preserves whitespace surrounding a chip', () => {
    const result = serializeComposerDoc(
      doc(composerText('  '), composerFileChip('src/app.tsx'), composerText('  ')),
    )
    expect(result).toBe('  [app.tsx](src/app.tsx)  ')
  })

  // A path containing the separator is exactly what no `@path` + space rule
  // could ever encode unambiguously.
  it('encodes a path containing spaces', () => {
    expect(serializeComposerDoc(doc(composerFileChip('src/my file.tsx')))).toBe('[my file.tsx](src/my%20file.tsx)')
  })

  it('escapes brackets in the label and parentheses in the destination', () => {
    expect(serializeComposerDoc(doc(composerFileChip('src/a(1)[x].tsx')))).toBe(
      '[a(1)\\[x\\].tsx](src/a%281%29%5Bx%5D.tsx)',
    )
  })

  it('serializes a skill chip to a bracketed, scheme-qualified link', () => {
    expect(serializeComposerDoc(doc(composerSkillChip('review')))).toBe('[$review](skill:review)')
  })

  it('does not let a skill chip swallow the word that follows it', () => {
    const result = serializeComposerDoc(doc(composerSkillChip('review'), composerText('please')))
    expect(result).toBe('[$review](skill:review)please')
  })

  it('keeps two adjacent skill chips separately readable', () => {
    const result = serializeComposerDoc(doc(composerSkillChip('review'), composerSkillChip('refactor')))
    expect(result).toBe('[$review](skill:review)[$refactor](skill:refactor)')
  })

  it('keeps a skill chip and a file chip separately readable, adjacent', () => {
    const result = serializeComposerDoc(doc(composerSkillChip('review'), composerFileChip('src/app.tsx')))
    expect(result).toBe('[$review](skill:review)[app.tsx](src/app.tsx)')
  })

  it('encodes a skill name containing spaces', () => {
    expect(serializeComposerDoc(doc(composerSkillChip('Data Report')))).toBe('[$Data Report](skill:Data%20Report)')
  })

  it('escapes brackets in the skill label', () => {
    // escapeMarkdownLinkLabel only escapes \, [, ] — the label never needs
    // paren-escaping (that's only special inside the destination).
    expect(serializeComposerDoc(doc(composerSkillChip('foo[bar]')))).toBe('[$foo\\[bar\\]](skill:foo%5Bbar%5D)')
  })

  it('escapes parentheses and percent in the skill destination', () => {
    expect(serializeComposerDoc(doc(composerSkillChip('foo(bar)%baz')))).toBe(
      '[$foo(bar)%baz](skill:foo%28bar%29%25baz)',
    )
  })

  it('discriminates file and skill chips by scheme — file never carries one, skill always does', () => {
    const fileResult = serializeComposerDoc(doc(composerFileChip('src/app.tsx')))
    const skillResult = serializeComposerDoc(doc(composerSkillChip('code-review')))
    expect(fileResult).not.toMatch(/\]\(skill:/)
    expect(skillResult).toMatch(/\]\(skill:/)
  })

  it('ignores label and only serializes value for a skill chip', () => {
    const result = serializeComposerDoc(doc(composerSkillChip('review', 'a totally different label')))
    expect(result).toBe('[$review](skill:review)')
  })

  it('serializes a terminal-context chip to a bracketed, terminal-scheme link', () => {
    expect(
      serializeComposerDoc(doc(composerTerminalContextChip('sess-7f2a/L12-L40', 'Terminal 1 lines 12-40'))),
    ).toBe('[Terminal 1 lines 12-40](terminal:sess-7f2a/L12-L40)')
  })

  it('does not let a terminal-context chip swallow the word that follows it', () => {
    const result = serializeComposerDoc(
      doc(composerTerminalContextChip('sess-7f2a/L12-L40', 'Terminal 1 lines 12-40'), composerText('please')),
    )
    expect(result).toBe('[Terminal 1 lines 12-40](terminal:sess-7f2a/L12-L40)please')
  })

  it('keeps two adjacent terminal-context chips separately readable', () => {
    const result = serializeComposerDoc(
      doc(
        composerTerminalContextChip('sess-7f2a/L12-L40', 'Terminal 1 lines 12-40'),
        composerTerminalContextChip('sess-9b1c/L1-L5', 'Terminal 2 lines 1-5'),
      ),
    )
    expect(result).toBe(
      '[Terminal 1 lines 12-40](terminal:sess-7f2a/L12-L40)[Terminal 2 lines 1-5](terminal:sess-9b1c/L1-L5)',
    )
  })

  it('escapes brackets in the terminal-context label', () => {
    expect(
      serializeComposerDoc(doc(composerTerminalContextChip('sess-7f2a/L12-L40', 'Terminal [main] lines 12-40'))),
    ).toBe('[Terminal \\[main\\] lines 12-40](terminal:sess-7f2a/L12-L40)')
  })

  it('encodes a terminal-context session key containing spaces', () => {
    expect(serializeComposerDoc(doc(composerTerminalContextChip('sess 7f2a/L12-L40')))).toBe(
      '[sess 7f2a/L12-L40](terminal:sess%207f2a/L12-L40)',
    )
  })

  it('falls back to value verbatim as the label when none is supplied', () => {
    expect(serializeComposerDoc(doc(composerTerminalContextChip('sess-7f2a/L12-L40')))).toBe(
      '[sess-7f2a/L12-L40](terminal:sess-7f2a/L12-L40)',
    )
  })

  it('ignores label and only serializes value', () => {
    const result = serializeComposerDoc(doc(composerFileChip('src/app.tsx', 'a totally different label')))
    expect(result).toBe('[app.tsx](src/app.tsx)')
  })
})

describe('parseComposerText', () => {
  it('parses an empty string into an empty document', () => {
    expect(parseComposerText('')).toEqual(emptyComposerDoc())
  })

  it('parses a plain string into a single text node', () => {
    expect(parseComposerText('fix the login bug')).toEqual(doc(composerText('fix the login bug')))
  })

  it('does not reconstruct chips from an @-prefixed string', () => {
    // Serialization is one-way: an external string is always plain text,
    // even if it happens to contain what looks like a serialized chip.
    expect(parseComposerText('@src/app.tsx')).toEqual(doc(composerText('@src/app.tsx')))
  })

  it('round-trips a text-only document through serialize then parse', () => {
    const original = doc(composerText('hello world'))
    expect(parseComposerText(serializeComposerDoc(original))).toEqual(original)
  })
})
