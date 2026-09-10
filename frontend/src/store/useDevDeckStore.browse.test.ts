import { beforeEach, describe, expect, it } from 'vitest'
import { formatBrowsePath, useDevDeckStore } from '@/store/useDevDeckStore'

// Regression coverage for the folder browser being stuck under ~: before this
// fix, browse.path was always home-relative segments and openBrowse silently
// collapsed any absolute or Windows drive path back to home (see
// parseBrowseInitialPath). These lock in that a machine with multiple disks
// (or a plain "/") is actually reachable now.

function resetBrowse() {
  useDevDeckStore.setState((s) => {
    s.browse = { open: false, target: 'newPath', root: '~', path: [], machineId: '' }
  })
}

describe('folder browser root handling', () => {
  beforeEach(resetBrowse)

  it('opening with no initial path defaults to home', () => {
    useDevDeckStore.getState().openBrowse('newPath', undefined, 'm-1')
    expect(useDevDeckStore.getState().browse).toMatchObject({ root: '~', path: [] })
  })

  it('parses an absolute unix path into the "/" root', () => {
    useDevDeckStore.getState().openBrowse('newPath', '/Volumes/Data/projects', 'm-1')
    expect(useDevDeckStore.getState().browse).toMatchObject({ root: '/', path: ['Volumes', 'Data', 'projects'] })
  })

  it('parses a Windows drive path into a drive root', () => {
    useDevDeckStore.getState().openBrowse('newPath', 'D:\\Code\\devdeck', 'm-1')
    expect(useDevDeckStore.getState().browse).toMatchObject({ root: 'D:\\', path: ['Code', 'devdeck'] })
  })

  it('switching root via browseToRoot clears any existing segments', () => {
    const { openBrowse, enterFolder, browseToRoot } = useDevDeckStore.getState()
    openBrowse('newPath', '~/work', 'm-1')
    enterFolder('sub')
    browseToRoot('D:\\')
    expect(useDevDeckStore.getState().browse).toMatchObject({ root: 'D:\\', path: [] })
  })

  it('browseToPath jumps straight to a typed/pasted path, replacing any existing segments', () => {
    const { openBrowse, enterFolder, browseToPath } = useDevDeckStore.getState()
    openBrowse('newPath', '~/work', 'm-1')
    enterFolder('sub')
    browseToPath('D:\\Code\\devdeck')
    expect(useDevDeckStore.getState().browse).toMatchObject({ root: 'D:\\', path: ['Code', 'devdeck'] })
  })

  it('browseToPath understands a plain unix path and falls back to home for garbage input', () => {
    const { openBrowse, browseToPath } = useDevDeckStore.getState()
    openBrowse('newPath', undefined, 'm-1')
    browseToPath('/Volumes/Data')
    expect(useDevDeckStore.getState().browse).toMatchObject({ root: '/', path: ['Volumes', 'Data'] })

    browseToPath('not-a-real-path')
    expect(useDevDeckStore.getState().browse).toMatchObject({ root: '~', path: [] })
  })

  it('useFolder formats the final path per-root and writes it to the right target field', () => {
    const store = useDevDeckStore.getState()
    store.openBrowse('newPath', '/', 'm-1')
    store.enterFolder('etc')
    store.useFolder()
    expect(useDevDeckStore.getState().newProject.path).toBe('/etc')

    store.openBrowse('cloneParent', 'D:\\', 'm-1')
    store.enterFolder('Repos')
    store.useFolder()
    expect(useDevDeckStore.getState().newProject.cloneParent).toBe('D:\\Repos')
  })
})

describe('formatBrowsePath', () => {
  it('joins home-relative segments with /', () => {
    expect(formatBrowsePath('~', [])).toBe('~')
    expect(formatBrowsePath('~', ['a', 'b'])).toBe('~/a/b')
  })

  it('joins unix-root segments with /', () => {
    expect(formatBrowsePath('/', [])).toBe('/')
    expect(formatBrowsePath('/', ['etc'])).toBe('/etc')
  })

  it('joins windows drive segments with \\', () => {
    expect(formatBrowsePath('D:\\', [])).toBe('D:\\')
    expect(formatBrowsePath('D:\\', ['Code', 'app'])).toBe('D:\\Code\\app')
  })
})
