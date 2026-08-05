import { describe, expect, it } from 'vitest'
import { basename, parentPath, planDrop, resolveDropFolder } from './dropTarget'

describe('resolveDropFolder', () => {
  it('targets a folder row itself', () => {
    expect(resolveDropFolder({ path: 'src/lib', isDir: true })).toBe('src/lib')
  })

  it('targets a file row’s containing folder', () => {
    expect(resolveDropFolder({ path: 'src/lib/a.ts', isDir: false })).toBe('src/lib')
  })

  it('targets the tree root for a top-level file', () => {
    expect(resolveDropFolder({ path: 'README.md', isDir: false })).toBe('')
  })

  // The regression this module exists for: a drop over empty space used to
  // resolve to the *selected* entry's parent, which for a click-then-drag is
  // the dragged file's own folder — every move filtered out, nothing said.
  it('targets the tree root when the pointer is over no row', () => {
    expect(resolveDropFolder(null)).toBe('')
  })
})

describe('planDrop', () => {
  it('rewrites each path onto the destination folder', () => {
    const plan = planDrop(['a/b.txt', 'c/d.txt'], 'dest')
    expect(plan).toEqual({ ok: true, alreadyThere: 0, moves: [
      { from: 'a/b.txt', to: 'dest/b.txt' },
      { from: 'c/d.txt', to: 'dest/d.txt' },
    ] })
  })

  it('drops the leading slash when the destination is the tree root', () => {
    expect(planDrop(['a/b.txt'], '')).toEqual({ ok: true, alreadyThere: 0, moves: [{ from: 'a/b.txt', to: 'b.txt' }] })
  })

  it('rejects dropping a folder into itself', () => {
    const plan = planDrop(['src'], 'src')
    expect(plan.ok).toBe(false)
    expect(plan.ok === false && plan.reason).toMatch(/into itself/)
  })

  it('rejects dropping a folder into its own descendant', () => {
    const plan = planDrop(['src'], 'src/nested/deep')
    expect(plan.ok).toBe(false)
  })

  it('does not mistake a sibling with a shared prefix for a descendant', () => {
    // `src2` only *looks* like it lives under `src` on a raw startsWith.
    expect(planDrop(['src'], 'src2').ok).toBe(true)
  })

  it('counts entries already in the destination instead of moving them', () => {
    const plan = planDrop(['docs/a.md', 'src/b.ts'], 'docs')
    expect(plan).toEqual({ ok: true, alreadyThere: 1, moves: [{ from: 'src/b.ts', to: 'docs/b.ts' }] })
  })

  it('reports a pure no-op when every entry already lives there', () => {
    const plan = planDrop(['docs/a.md'], 'docs')
    expect(plan).toEqual({ ok: true, alreadyThere: 1, moves: [] })
  })

  it('handles an empty selection', () => {
    expect(planDrop([], 'docs')).toEqual({ ok: true, alreadyThere: 0, moves: [] })
  })
})

describe('path helpers', () => {
  it('splits parents and basenames', () => {
    expect(parentPath('a/b/c.txt')).toBe('a/b')
    expect(parentPath('c.txt')).toBe('')
    expect(basename('a/b/c.txt')).toBe('c.txt')
    expect(basename('c.txt')).toBe('c.txt')
  })
})
