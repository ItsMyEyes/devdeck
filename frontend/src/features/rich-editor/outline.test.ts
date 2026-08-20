import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createEditorExtensions } from './extensions'
import { collectHeadings } from './outline'

function docFrom(markdown: string) {
  const editor = new Editor({
    extensions: createEditorExtensions(),
    content: markdown,
    contentType: 'markdown',
  })
  const { doc } = editor.state
  editor.destroy()
  return doc
}

describe('collectHeadings', () => {
  it('reads every heading in document order, with its level', () => {
    const headings = collectHeadings(docFrom('# One\n\ntext\n\n### Deep\n\n## Two'))

    expect(headings.map((heading) => [heading.level, heading.text])).toEqual([
      [1, 'One'],
      [3, 'Deep'],
      [2, 'Two'],
    ])
  })

  it('returns positions that resolve back to the heading node', () => {
    const doc = docFrom('# Title\n\nbody\n\n## Section')
    const headings = collectHeadings(doc)

    expect(headings).toHaveLength(2)
    for (const heading of headings) {
      const node = doc.nodeAt(heading.pos)
      expect(node?.type.name).toBe('heading')
      expect(node?.textContent.trim()).toBe(heading.text)
    }
  })

  it('keeps an empty heading, so the rail still shows the document shape', () => {
    // A heading the user has just created and not typed into yet.
    const headings = collectHeadings(docFrom('# \n\n## Written'))

    expect(headings.map((heading) => heading.text)).toEqual(['', 'Written'])
  })

  it('has nothing to report for a document without headings', () => {
    expect(collectHeadings(docFrom('just a paragraph\n\n- and a list'))).toEqual([])
  })
})
