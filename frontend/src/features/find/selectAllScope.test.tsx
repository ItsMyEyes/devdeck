import { useRef } from 'react'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetKeybindingsForTests } from '@/features/keybindings/store'
import { selectAllWithin, useSelectAllScope } from './selectAllScope'

afterEach(() => {
  __resetKeybindingsForTests()
  document.body.innerHTML = ''
})

function pressSelectAll(target: Element | Document = document) {
  const event = new KeyboardEvent('keydown', {
    key: 'a',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
  return event
}

function Harness({ onSelectAll }: { onSelectAll?: () => boolean | void } = {}) {
  const ref = useRef<HTMLDivElement>(null)
  useSelectAllScope(ref, { onSelectAll })
  return (
    <div ref={ref} data-testid="scope">
      <p>document text</p>
      <input aria-label="find" defaultValue="query" />
      <div contentEditable suppressContentEditableWarning data-testid="canvas">
        canvas text
      </div>
    </div>
  )
}

describe('selectAllWithin', () => {
  it('puts only the given container in the selection', () => {
    document.body.innerHTML = '<div id="other">outside</div><div id="scope"><p>inside</p></div>'
    const scope = document.getElementById('scope')!
    expect(selectAllWithin(scope)).toBe(true)
    expect(window.getSelection()?.toString()).toBe('inside')
  })

  it('reports failure rather than throwing on a missing element', () => {
    expect(selectAllWithin(null)).toBe(false)
  })
})

describe('useSelectAllScope', () => {
  it('claims the chord for content inside the scope', () => {
    const { getByText } = render(<Harness />)
    const event = pressSelectAll(getByText('document text'))
    expect(event.defaultPrevented).toBe(true)
    expect(window.getSelection()?.toString()).toContain('document text')
  })

  it('ignores a keypress from outside the scope', () => {
    render(<Harness />)
    document.body.appendChild(document.createElement('span'))
    const event = pressSelectAll(document.body)
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves a native input to the browser, so Select All in the find box still works', () => {
    const { getByLabelText } = render(<Harness />)
    const event = pressSelectAll(getByLabelText('find'))
    expect(event.defaultPrevented).toBe(false)
  })

  it("leaves a contenteditable to its editor's own keymap", () => {
    // ProseMirror binds Mod-a itself; overriding it with a DOM range would
    // hand the editor a selection it cannot map back to its document.
    const { getByTestId } = render(<Harness />)
    const canvas = getByTestId('canvas')
    // jsdom does not derive `isContentEditable` from the attribute.
    Object.defineProperty(canvas, 'isContentEditable', { value: true, configurable: true })
    const event = pressSelectAll(canvas)
    expect(event.defaultPrevented).toBe(false)
  })

  it('lets a surface claim the chord for its own editor selection', () => {
    const onSelectAll = vi.fn(() => true)
    const { getByText } = render(<Harness onSelectAll={onSelectAll} />)
    const event = pressSelectAll(getByText('document text'))
    expect(onSelectAll).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })
})
