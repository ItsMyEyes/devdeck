import { useEffect, useRef, useState } from 'react'
import { Editor } from '@tiptap/core'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DocumentOutline } from './DocumentOutline'
import { createEditorExtensions } from './extensions'

/** The rail as it is actually used: a sibling of the scrolling page, handed the
 *  editor after mount. */
function Harness({ markdown }: { markdown: string }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)

  useEffect(() => {
    const instance = new Editor({
      extensions: createEditorExtensions(),
      content: markdown,
      contentType: 'markdown',
    })
    setEditor(instance)
    return () => instance.destroy()
  }, [markdown])

  return (
    <div>
      <div ref={scrollRef} />
      <DocumentOutline editor={editor} scrollRef={scrollRef} />
    </div>
  )
}

describe('DocumentOutline', () => {
  it('draws one dash per heading, each labelled with its text', () => {
    render(<Harness markdown={'# Intro\n\ntext\n\n## Details\n\n### Deeper'} />)

    const rail = screen.getByRole('navigation', { name: 'Document outline' })
    // Two rows of the same headings: the dashes, and the hover panel behind them.
    expect(screen.getAllByRole('button', { name: 'Intro' })).toHaveLength(2)
    expect(rail).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Details' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Deeper' })).toHaveLength(2)
  })

  it('stays out of the way of a document that has no outline', () => {
    render(<Harness markdown={'# Only one heading\n\nand some prose'} />)

    expect(screen.queryByRole('navigation', { name: 'Document outline' })).not.toBeInTheDocument()
  })

  it('names an untitled heading rather than rendering a nameless control', () => {
    render(<Harness markdown={'# \n\n## Second'} />)

    expect(screen.getAllByRole('button', { name: 'Untitled' })).toHaveLength(2)
  })
})
