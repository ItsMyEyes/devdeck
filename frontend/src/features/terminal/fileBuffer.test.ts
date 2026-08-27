import { describe, expect, it } from 'vitest'
import { editBuffer, hasExternalChange, seedBuffer, syncBuffer } from './fileBuffer'

describe('syncBuffer', () => {
  it('seeds from the first content the server returns', () => {
    expect(syncBuffer(null, 'hello')).toEqual({ draft: 'hello', baseline: 'hello' })
  })

  it('keeps the same object when the server repeats what we already have', () => {
    const buffer = seedBuffer('hello')
    expect(syncBuffer(buffer, 'hello')).toBe(buffer)
  })

  // The reported bug: an agent rewrites a file that is open in a tab nobody has
  // typed into, and the tab keeps showing the old text forever.
  it('adopts an external change into a clean buffer', () => {
    const buffer = seedBuffer('before')
    expect(syncBuffer(buffer, 'after')).toEqual({ draft: 'after', baseline: 'after' })
  })

  // The other half, and the reason the one-shot latch existed at all: a refetch
  // must never overwrite what the operator is mid-way through typing.
  it('refuses to overwrite unsaved edits', () => {
    const buffer = editBuffer(seedBuffer('before'), 'my edit')!
    expect(syncBuffer(buffer, 'after')).toBe(buffer)
  })

  // A save writes the draft back and seeds the cache with it. Without this the
  // baseline would stay pinned to the pre-save text and every later external
  // change would look like a conflict against edits that no longer exist.
  it('rebases the baseline when the server catches up with the draft', () => {
    const buffer = editBuffer(seedBuffer('before'), 'my edit')!
    expect(syncBuffer(buffer, 'my edit')).toEqual({ draft: 'my edit', baseline: 'my edit' })
  })

  it('adopts again after a conflict is resolved by saving', () => {
    let buffer = editBuffer(seedBuffer('v1'), 'mine')!
    buffer = syncBuffer(buffer, 'agent v2') // conflict: held
    buffer = syncBuffer(buffer, 'mine') // saved: baseline rebased
    expect(syncBuffer(buffer, 'agent v3')).toEqual({ draft: 'agent v3', baseline: 'agent v3' })
  })
})

describe('editBuffer', () => {
  it('records a local edit without moving the baseline', () => {
    expect(editBuffer(seedBuffer('before'), 'typed')).toEqual({ draft: 'typed', baseline: 'before' })
  })

  it('is a no-op for an unchanged draft, so a controlled echo cannot re-render', () => {
    const buffer = seedBuffer('before')
    expect(editBuffer(buffer, 'before')).toBe(buffer)
  })

  // Monaco echoes its own model content back through onChange. Before the file
  // has loaded that echo is the empty placeholder, and taking it would seed a
  // buffer whose baseline is '' — every later load would then read as a
  // conflict against an edit the operator never made.
  it('ignores changes that arrive before the file has loaded', () => {
    expect(editBuffer(null, 'echo')).toBeNull()
  })
})

describe('hasExternalChange', () => {
  it('is false for a clean buffer', () => {
    expect(hasExternalChange(seedBuffer('same'), 'same')).toBe(false)
  })

  it('is false while only the operator has changed the file', () => {
    const buffer = editBuffer(seedBuffer('before'), 'typed')!
    expect(hasExternalChange(buffer, 'before')).toBe(false)
  })

  it('is false for a change that was adopted rather than held', () => {
    const buffer = seedBuffer('before')
    expect(hasExternalChange(buffer, 'after')).toBe(false)
  })

  it('is true only when disk moved under an unsaved edit', () => {
    const buffer = editBuffer(seedBuffer('v1'), 'mine')!
    expect(hasExternalChange(buffer, 'agent v2')).toBe(true)
  })

  // The frame after a save: the mutation seeds the cache with the draft, and
  // the effect that rebases the baseline has not run yet. Reporting a conflict
  // here would flash the reload bar on every single save.
  it('is false when the incoming content already equals the draft', () => {
    const buffer = editBuffer(seedBuffer('v1'), 'mine')!
    expect(hasExternalChange(buffer, 'mine')).toBe(false)
  })

  it('is false before the file has loaded', () => {
    expect(hasExternalChange(null, 'anything')).toBe(false)
    expect(hasExternalChange(seedBuffer('v1'), undefined)).toBe(false)
  })
})
