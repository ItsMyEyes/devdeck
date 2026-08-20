import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotionEditor } from './NotionEditor'

// The real thing is a multi-megabyte lazy chunk that needs layout to render;
// what these tests are about is which fences reach it, not what it draws.
const render_ = vi.hoisted(() => vi.fn(async (id: string) => ({ svg: `<svg data-id="${id}" />` })))
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: render_ } }))

const DIAGRAM = '```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```'

function source(): HTMLElement | null {
  return document.querySelector('.notion-mermaid__source')
}
function diagram(): HTMLElement | null {
  return document.querySelector('.notion-mermaid__diagram')
}

describe('mermaid code block', () => {
  beforeEach(() => {
    render_.mockClear()
  })

  it('renders the diagram from the fence, and keeps the fence editable', async () => {
    render(<NotionEditor value={DIAGRAM} onChange={vi.fn()} />)

    // The node view mounts on its own React root, so nothing about it is on
    // screen in the render pass that created the editor.
    await waitFor(() => expect(diagram()?.querySelector('svg')).toBeInTheDocument())
    // The diagram is drawn from exactly the fence's source…
    expect(render_).toHaveBeenCalledWith(expect.any(String), 'graph TD\n  A[Start] --> B[Done]')
    // …which survives alongside it as an editable code block.
    expect(source()).toHaveTextContent('graph TD')
  })

  it('renders the diagram on a read-only canvas too', async () => {
    render(<NotionEditor value={DIAGRAM} onChange={vi.fn()} editable={false} ariaLabel="Read only" />)

    await waitFor(() => expect(diagram()?.querySelector('svg')).toBeInTheDocument())
    // The source is still in the document — it is hidden by CSS keyed off this
    // attribute, not unmounted, because ProseMirror owns that element.
    expect(screen.getByLabelText('Read only')).toHaveAttribute('contenteditable', 'false')
    expect(source()).toBeInTheDocument()
  })

  // The node view is deliberately scoped to mermaid: every other fence must
  // keep rendering through CodeBlock's own renderHTML.
  it('leaves a fence in another language alone', () => {
    render(<NotionEditor value={'```ts\nconst a = 1\n```'} onChange={vi.fn()} />)

    expect(source()).toBeNull()
    expect(diagram()).toBeNull()
    expect(document.querySelector('pre > code')).toHaveTextContent('const a = 1')
  })

  it('does not reach for mermaid at all when there is no diagram', () => {
    render(<NotionEditor value={'# Just prose\n\n```ts\nconst a = 1\n```'} onChange={vi.fn()} />)
    expect(render_).not.toHaveBeenCalled()
  })
})
