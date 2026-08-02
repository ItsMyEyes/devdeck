import { describe, expect, it } from 'vitest'
import { recordPageLoad } from './browserHistory'

const at = (history: string[], historyIndex: number) => ({ history, historyIndex })

describe('recordPageLoad', () => {
  describe('loads DevDeck initiated itself', () => {
    it('confirms the entry already written for a typed URL', () => {
      expect(recordPageLoad(at(['https://a.test/'], 0), 'https://a.test/', true)).toEqual(at(['https://a.test/'], 0))
    })

    it('rewrites the current entry to the URL that actually committed after a redirect', () => {
      // navigate() optimistically records what the user typed; the server sent
      // us somewhere else. Back must return to the previous page, not bounce
      // through the pre-redirect URL again.
      expect(recordPageLoad(at(['https://x.test/', 'https://google.com/'], 1), 'https://www.google.com/', true)).toEqual(
        at(['https://x.test/', 'https://www.google.com/'], 1),
      )
    })

    it('appends when there is no entry to confirm yet', () => {
      expect(recordPageLoad(at([], -1), 'https://a.test/', true)).toEqual(at(['https://a.test/'], 0))
    })
  })

  describe('in-page navigation the webview performed on its own', () => {
    // The reported bug: clicking a search result inside the page left
    // historyIndex at 0, so canGoBack (historyIndex > 0) stayed false and the
    // back button never enabled.
    it('appends a link click so back becomes available', () => {
      expect(recordPageLoad(at(['https://google.com/'], 0), 'https://google.com/search?q=d', false)).toEqual(
        at(['https://google.com/', 'https://google.com/search?q=d'], 1),
      )
    })

    it('drops the forward entries when navigating away from a rewound position', () => {
      const state = at(['https://a.test/', 'https://b.test/', 'https://c.test/'], 0)
      expect(recordPageLoad(state, 'https://d.test/', false)).toEqual(at(['https://a.test/', 'https://d.test/'], 1))
    })

    it('ignores a reload of the current entry', () => {
      expect(recordPageLoad(at(['https://a.test/', 'https://b.test/'], 1), 'https://b.test/', false)).toEqual(
        at(['https://a.test/', 'https://b.test/'], 1),
      )
    })

    // A trackpad swipe or mouse side-button drives the webview's own session
    // history without going through our toolbar, so the index has to follow
    // rather than the URL being appended as a brand-new entry.
    it('steps back when the webview navigated to the previous entry itself', () => {
      expect(recordPageLoad(at(['https://a.test/', 'https://b.test/'], 1), 'https://a.test/', false)).toEqual(
        at(['https://a.test/', 'https://b.test/'], 0),
      )
    })

    it('steps forward when the webview navigated to the next entry itself', () => {
      expect(recordPageLoad(at(['https://a.test/', 'https://b.test/'], 0), 'https://b.test/', false)).toEqual(
        at(['https://a.test/', 'https://b.test/'], 1),
      )
    })

    it('appends from an empty history', () => {
      expect(recordPageLoad(at([], -1), 'https://a.test/', false)).toEqual(at(['https://a.test/'], 0))
    })
  })

  it('never mutates the state it is given', () => {
    const state = at(['https://a.test/'], 0)
    recordPageLoad(state, 'https://b.test/', false)
    expect(state).toEqual(at(['https://a.test/'], 0))
  })
})
