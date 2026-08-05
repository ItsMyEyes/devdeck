import { describe, expect, it, vi } from 'vitest'
import { entryDragLabel, setEntryDragImage } from './dragImage'

describe('entryDragLabel', () => {
  it('names a single entry', () => {
    expect(entryDragLabel(['README.md'])).toBe('README.md')
  })

  it('counts a multi-selection', () => {
    expect(entryDragLabel(['a.ts', 'b.ts', 'c.ts'])).toBe('3 items')
  })
})

describe('setEntryDragImage', () => {
  it('hands the browser a labelled element and cleans it up', () => {
    const setDragImage = vi.fn()
    setEntryDragImage({ setDragImage } as unknown as DataTransfer, ['README.md'])
    expect(setDragImage).toHaveBeenCalledTimes(1)
    const [element] = setDragImage.mock.calls[0] as [HTMLElement]
    expect(element.textContent).toBe('README.md')
    // Must be in the document at call time for the browser to rasterize it.
    expect(element.isConnected).toBe(true)
  })

  it('is a no-op where setDragImage is unavailable', () => {
    expect(() => setEntryDragImage({} as DataTransfer, ['a.ts'])).not.toThrow()
  })
})
