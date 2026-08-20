import { describe, expect, it } from 'vitest'
import { joinFrontmatter, splitFrontmatter } from './frontmatter'

/** The property the whole scheme rests on: whatever the editor does to the
 *  body, re-attaching the frontmatter must reproduce the original bytes when
 *  the body comes back unchanged. */
function roundTrip(source: string) {
  const { frontmatter, body } = splitFrontmatter(source)
  return joinFrontmatter(frontmatter, body)
}

describe('splitFrontmatter', () => {
  it('splits a leading YAML block off the body', () => {
    const source = '---\ntitle: Hello\ntags: [a, b]\n---\n\n# Heading\n'
    expect(splitFrontmatter(source)).toEqual({
      frontmatter: '---\ntitle: Hello\ntags: [a, b]\n---\n',
      body: '\n# Heading\n',
    })
  })

  it('leaves a document with no frontmatter alone', () => {
    const source = '# Heading\n\nSome prose.\n'
    expect(splitFrontmatter(source)).toEqual({ frontmatter: '', body: source })
  })

  it('does not mistake leading horizontal rules for frontmatter', () => {
    const source = '---\n\n---\n\nProse.\n'
    expect(splitFrontmatter(source).frontmatter).toBe('')
  })

  it('does not mistake a setext heading for frontmatter', () => {
    const source = '---\nJust some prose that happens to sit between rules\n---\n'
    expect(splitFrontmatter(source).frontmatter).toBe('')
  })

  it('accepts a comment-first block', () => {
    const source = '---\n# generated, do not edit\nid: 7\n---\nBody\n'
    expect(splitFrontmatter(source).frontmatter).toBe('---\n# generated, do not edit\nid: 7\n---\n')
  })

  it('stops at the first closing fence, not a later horizontal rule', () => {
    const source = '---\ntitle: x\n---\n\nIntro\n\n---\n\nOutro\n'
    expect(splitFrontmatter(source)).toEqual({
      frontmatter: '---\ntitle: x\n---\n',
      body: '\nIntro\n\n---\n\nOutro\n',
    })
  })

  it('handles a file that is nothing but frontmatter', () => {
    const source = '---\ntitle: x\n---'
    expect(splitFrontmatter(source)).toEqual({ frontmatter: source, body: '' })
  })

  it('ignores an unterminated block', () => {
    const source = '---\ntitle: x\n\nstill going\n'
    expect(splitFrontmatter(source)).toEqual({ frontmatter: '', body: source })
  })

  it('ignores a block that does not start at the very top', () => {
    const source = '\n---\ntitle: x\n---\n'
    expect(splitFrontmatter(source).frontmatter).toBe('')
  })
})

describe('joinFrontmatter', () => {
  it.each([
    '---\ntitle: Hello\n---\n\n# Heading\n',
    '---\ntitle: x\n---',
    '# Heading\n\nProse.\n',
    '',
    '---\r\ntitle: crlf\r\n---\r\nBody\r\n',
  ])('round-trips %j unchanged', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it('keeps the closing fence off the body when the block ran to EOF', () => {
    const { frontmatter } = splitFrontmatter('---\ntitle: x\n---')
    expect(joinFrontmatter(frontmatter, '# Added later\n')).toBe('---\ntitle: x\n---\n# Added later\n')
  })

  it('returns the body untouched when there is no frontmatter', () => {
    expect(joinFrontmatter('', '# Heading\n')).toBe('# Heading\n')
  })
})
