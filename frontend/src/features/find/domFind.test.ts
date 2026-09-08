import { describe, expect, it } from 'vitest'
import { findTextRanges } from './domFind'

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

/** What a highlight would actually paint, so assertions read as the feature. */
function texts(ranges: Range[]): string[] {
  return ranges.map((range) => range.toString())
}

describe('findTextRanges', () => {
  it('finds every occurrence in document order', () => {
    const root = mount('<p>one two one two one</p>')
    const ranges = findTextRanges(root, 'one')
    expect(ranges).toHaveLength(3)
    expect(texts(ranges)).toEqual(['one', 'one', 'one'])
    expect(ranges[0].startOffset).toBe(0)
    expect(ranges[2].startOffset).toBe(16)
  })

  it('is case-insensitive by default and exact when asked', () => {
    const root = mount('<p>Deploy the deploy</p>')
    expect(findTextRanges(root, 'DEPLOY')).toHaveLength(2)
    expect(findTextRanges(root, 'Deploy', { caseSensitive: true })).toHaveLength(1)
  })

  it('matches across inline formatting, which is the whole reason for the flattening', () => {
    // `hello **world**` renders as two text nodes; a per-node search misses it.
    const root = mount('<p>hello <strong>world</strong></p>')
    const ranges = findTextRanges(root, 'hello world')
    expect(ranges).toHaveLength(1)
    expect(ranges[0].toString()).toBe('hello world')
  })

  it('does not match across a block boundary', () => {
    const root = mount('<p>foo</p><p>bar</p>')
    expect(findTextRanges(root, 'foobar')).toHaveLength(0)
    expect(findTextRanges(root, 'foo')).toHaveLength(1)
  })

  it('skips chrome: the find bar itself, hidden nodes, and script text', () => {
    const root = mount(
      '<div data-find-skip><input value="needle" />needle</div>' +
        '<p hidden>needle</p>' +
        '<p aria-hidden="true">needle</p>' +
        '<script>needle</script>' +
        '<p>needle</p>',
    )
    const ranges = findTextRanges(root, 'needle')
    expect(ranges).toHaveLength(1)
    expect(ranges[0].startContainer.parentElement?.tagName).toBe('P')
  })

  it('treats overlapping occurrences the way a find bar does — non-overlapping', () => {
    const root = mount('<p>aaaa</p>')
    expect(findTextRanges(root, 'aa')).toHaveLength(2)
  })

  it('returns nothing for an empty query rather than matching everything', () => {
    const root = mount('<p>content</p>')
    expect(findTextRanges(root, '')).toEqual([])
  })

  it('stops at the limit so a one-character query cannot lock the frame', () => {
    const root = mount(`<p>${'a'.repeat(500)}</p>`)
    expect(findTextRanges(root, 'a', { limit: 10 })).toHaveLength(10)
  })

  it('tolerates a null root', () => {
    expect(findTextRanges(null, 'anything')).toEqual([])
  })
})
