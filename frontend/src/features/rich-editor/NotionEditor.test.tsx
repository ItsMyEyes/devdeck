import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NotionEditor } from './NotionEditor'

/** The user-visible half of the migration: markdown goes in and comes out as
 *  a rendered document, never as syntax sitting on screen. */
describe('NotionEditor', () => {
  it('renders markdown as document structure, not as source text', () => {
    render(<NotionEditor value={'# Hello\n\n- a\n- b'} onChange={vi.fn()} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Hello' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['a', 'b'])
    expect(screen.queryByText('# Hello')).not.toBeInTheDocument()
  })

  it('renders task list state as checkboxes', () => {
    render(<NotionEditor value={'- [ ] todo\n- [x] done'} onChange={vi.fn()} />)

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((box) => box.checked)).toEqual([false, true])
  })

  it('stays empty until `ready`, then takes the loaded content', () => {
    function Harness({ ready }: { ready: boolean }) {
      return <NotionEditor value="# Loaded" ready={ready} onChange={vi.fn()} />
    }
    const { rerender } = render(<Harness ready={false} />)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()

    rerender(<Harness ready />)
    expect(screen.getByRole('heading', { level: 1, name: 'Loaded' })).toBeInTheDocument()
  })

  it('pushes an external value change into the document', () => {
    function Harness() {
      const [value, setValue] = useState('# First')
      return (
        <>
          <button type="button" onClick={() => setValue('# Second')}>
            swap
          </button>
          <NotionEditor value={value} onChange={vi.fn()} />
        </>
      )
    }
    render(<Harness />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('First')

    fireEvent.click(screen.getByRole('button', { name: 'swap' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Second')
  })

  it('exposes the aria label on the editable surface', () => {
    render(<NotionEditor value="text" onChange={vi.fn()} ariaLabel="Edit notes.md" />)
    expect(screen.getByLabelText('Edit notes.md')).toHaveAttribute('contenteditable', 'true')
  })

  it('is not editable when told not to be', () => {
    render(<NotionEditor value="text" onChange={vi.fn()} editable={false} ariaLabel="Read only" />)
    expect(screen.getByLabelText('Read only')).toHaveAttribute('contenteditable', 'false')
  })
})
