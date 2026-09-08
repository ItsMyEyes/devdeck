/**
 * The "?" button is the only way back into the tutorials once the automatic
 * first run is over, and the only place their language is chosen — so what is
 * pinned here is that the right chapter reaches `startTour`, that the language
 * choice survives a reload and re-labels the panel it was made in, and that a
 * chapter whose screen is not open is offered as unavailable rather than
 * quietly opening onto nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { HelpFab } from '@/features/tour/HelpFab'
import { TOUR_LANG_STORAGE_KEY, TOUR_SEEN_STORAGE_KEY } from '@/features/tour/tourPrefs'
import { startTour } from '@/features/tour/startTour'
import { tourCopy } from '@/features/tour/tourCopy'

vi.mock('@/features/tour/startTour', () => ({
  startTour: vi.fn(() => Promise.resolve()),
  stopTour: vi.fn(),
  isTourActive: () => false,
  subscribeTourActive: () => () => {},
}))

const started = vi.mocked(startTour)

beforeEach(() => {
  window.localStorage.clear()
  started.mockClear()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

/** Most cases want the button as a returning user sees it: no automatic run
 *  pending, so nothing calls `startTour` except the click under test. */
function renderSeen() {
  window.localStorage.setItem(TOUR_SEEN_STORAGE_KEY, '1')
  return render(<HelpFab />)
}

function fab() {
  return screen.getByRole('button', { name: tourCopy('en').chrome.helpLabel })
}

/** Puts a laid-out anchor on the page so one deep chapter reads as available.
 *  jsdom hands every element a 0×0 rect, which `isTourTargetVisible` correctly
 *  refuses, so the geometry has to be stated. */
function placeAnchor(name: string) {
  const element = document.createElement('div')
  element.setAttribute('data-tour', name)
  element.getBoundingClientRect = () =>
    ({ x: 10, y: 10, top: 10, left: 10, width: 120, height: 40, right: 130, bottom: 50 }) as DOMRect
  document.body.append(element)
  return element
}

function chapterButton(lang: 'en' | 'id', chapter: 'overview' | 'workspace' | 'chat' | 'ssh') {
  return screen.getByRole('button', { name: new RegExp(tourCopy(lang).chapters[chapter].label) })
}

describe('HelpFab', () => {
  it('is a labelled button carrying the anchor its own final tour step points at', () => {
    renderSeen()

    expect(fab()).toHaveAttribute('data-tour', 'help-fab')
  })

  it('starts the chapter that was picked, and closes the panel', async () => {
    const user = userEvent.setup()
    renderSeen()

    await user.click(fab())
    await user.click(chapterButton('en', 'overview'))

    expect(started).toHaveBeenCalledWith('overview', 'en')
    expect(screen.queryByRole('button', { name: /Interface overview/ })).toBeNull()
  })

  it('offers the deep chapter whose screen is open, and starts that one', async () => {
    const user = userEvent.setup()
    placeAnchor('chat-input')
    renderSeen()

    await user.click(fab())
    await user.click(chapterButton('en', 'chat'))

    expect(started).toHaveBeenCalledWith('chat', 'en')
  })

  it('offers a chapter whose screen is closed as unavailable rather than starting it', async () => {
    const user = userEvent.setup()
    renderSeen()

    await user.click(fab())
    const ssh = chapterButton('en', 'ssh')

    expect(ssh).toBeDisabled()
    expect(ssh).toHaveTextContent(tourCopy('en').chrome.unavailable)
    await user.click(ssh)
    expect(started).not.toHaveBeenCalled()
  })

  it('re-labels itself in Indonesian once that language is picked, and starts in it', async () => {
    const user = userEvent.setup()
    renderSeen()

    await user.click(fab())
    await user.click(screen.getByRole('button', { name: /Bahasa Indonesia/ }))

    expect(window.localStorage.getItem(TOUR_LANG_STORAGE_KEY)).toBe('id')

    await user.click(chapterButton('id', 'overview'))
    expect(started).toHaveBeenCalledWith('overview', 'id')
  })

  it('reads the stored language back on a later visit', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(TOUR_LANG_STORAGE_KEY, 'id')
    window.localStorage.setItem(TOUR_SEEN_STORAGE_KEY, '1')
    render(<HelpFab />)

    await user.click(screen.getByRole('button', { name: tourCopy('id').chrome.helpLabel }))

    expect(chapterButton('id', 'overview')).toBeInTheDocument()
  })

  it('says "start" rather than "replay" for a chapter that has never run', async () => {
    const user = userEvent.setup()
    // The overview HAS been seen; the workspace chapter has not, and the two
    // must not share one flag.
    placeAnchor('pane-close')
    renderSeen()

    await user.click(fab())

    expect(chapterButton('en', 'overview')).toHaveAttribute('title', tourCopy('en').chrome.restart)
    expect(chapterButton('en', 'workspace')).toHaveAttribute('title', tourCopy('en').chrome.start)
  })
})

describe('HelpFab — automatic first run', () => {
  it('runs the tour once the shell has painted, for someone who has never seen it', () => {
    vi.useFakeTimers()
    const rail = document.createElement('nav')
    rail.setAttribute('data-tour', 'nav-rail')
    document.body.append(rail)

    render(<HelpFab />)
    expect(started).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(started).toHaveBeenCalledTimes(1)
    rail.remove()
  })

  it('stays out of the way of someone who has already seen it', () => {
    vi.useFakeTimers()
    const rail = document.createElement('nav')
    rail.setAttribute('data-tour', 'nav-rail')
    document.body.append(rail)

    renderSeen()
    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(started).not.toHaveBeenCalled()
    rail.remove()
  })

  it('gives up quietly when the shell never paints, leaving the offer for next time', () => {
    vi.useFakeTimers()
    render(<HelpFab />)

    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(started).not.toHaveBeenCalled()
    // Crucially NOT marked as seen — `startTour` owns that flag, and it never ran.
    expect(window.localStorage.getItem(TOUR_SEEN_STORAGE_KEY)).toBeNull()
  })
})
