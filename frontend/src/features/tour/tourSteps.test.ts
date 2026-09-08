/**
 * `buildTourSteps` is the part of the tour that has to survive reality: most of
 * its anchors are conditional chrome, and one of them (the sidebar on a phone)
 * is in the DOM but parked outside the viewport. The steps it emits are what
 * the reader counts through, so a step that will highlight nothing must be
 * gone before the tour starts rather than skipped once it has.
 *
 * With four chapters there is a second question to pin: which of them the "?"
 * panel may offer at all. That answer is also the DOM's, and getting it wrong
 * in either direction is visible — a greyed-out tour of the screen you are
 * looking at, or an offered tour that opens onto nothing.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { availableTourChapters, buildTourSteps, isTourChapterAvailable, isTourTargetVisible } from '@/features/tour/tourSteps'
import { tourCopy } from '@/features/tour/tourCopy'

const VIEW = { innerWidth: 1440, innerHeight: 900 }

/** jsdom gives every element a 0×0 rect at the origin, which `isTourTargetVisible`
 *  correctly reads as "not laid out". Tests therefore state each element's
 *  geometry explicitly. */
function place(element: Element, rect: Partial<DOMRect>) {
  const full = { x: 10, y: 10, top: 10, left: 10, width: 120, height: 40, right: 130, bottom: 50, ...rect }
  element.getBoundingClientRect = () => full as DOMRect
}

function anchor(name: string, rect: Partial<DOMRect> = {}): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('data-tour', name)
  document.body.append(element)
  place(element, rect)
  return element
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isTourTargetVisible', () => {
  it('rejects an element with no layout', () => {
    const element = anchor('nav-rail', { width: 0, height: 0, right: 0, bottom: 0 })
    expect(isTourTargetVisible(element, VIEW)).toBe(false)
  })

  it('rejects the mobile sidebar drawer parked off-canvas to the left', () => {
    // `-translate-x-full` on a 306px drawer: real size, entirely negative x.
    const element = anchor('nav-rail', { left: -306, right: -0.5, top: 0, bottom: 900, width: 306, height: 900 })
    expect(isTourTargetVisible(element, VIEW)).toBe(false)
  })

  it('accepts an element inside the viewport', () => {
    expect(isTourTargetVisible(anchor('nav-rail'), VIEW)).toBe(true)
  })
})

describe('buildTourSteps', () => {
  it('always opens with the centred welcome step, which targets nothing', () => {
    const steps = buildTourSteps('overview', 'en', document, VIEW)

    expect(steps).toHaveLength(1)
    expect(steps[0].element).toBeUndefined()
    expect(steps[0].popover?.title).toBe(tourCopy('en').steps.welcome.title)
  })

  it('drops anchors that are missing from the DOM entirely', () => {
    anchor('nav-rail')
    anchor('agents-new')

    const steps = buildTourSteps('overview', 'en', document, VIEW)

    // welcome + the two that exist — not the ten that do not.
    expect(steps).toHaveLength(3)
    expect(steps.map((step) => step.popover?.title)).toEqual([
      tourCopy('en').steps.welcome.title,
      tourCopy('en').steps['nav-rail'].title,
      tourCopy('en').steps['agents-new'].title,
    ])
  })

  it('drops an anchor that exists but is off-canvas', () => {
    anchor('nav-rail', { left: -306, right: -1, width: 306, height: 900, top: 0, bottom: 900 })
    anchor('agents-new')

    const steps = buildTourSteps('overview', 'en', document, VIEW)

    expect(steps.map((step) => step.popover?.title)).toEqual([
      tourCopy('en').steps.welcome.title,
      tourCopy('en').steps['agents-new'].title,
    ])
  })

  it('keeps the declared reading order regardless of DOM order', () => {
    // Appended toolbar-first, but the rail is meant to be narrated first.
    anchor('agents-new')
    anchor('nav-rail')

    const steps = buildTourSteps('overview', 'en', document, VIEW)

    expect(steps.map((step) => step.popover?.title)).toEqual([
      tourCopy('en').steps.welcome.title,
      tourCopy('en').steps['nav-rail'].title,
      tourCopy('en').steps['agents-new'].title,
    ])
  })

  it('resolves the element itself, so several cards yield one step on the first', () => {
    const first = anchor('worktree-card')
    anchor('worktree-card')
    anchor('worktree-card')

    const steps = buildTourSteps('overview', 'en', document, VIEW)

    expect(steps).toHaveLength(2)
    expect(steps[1].element).toBe(first)
  })

  it('narrates in Indonesian when asked, with the same steps', () => {
    anchor('agents-new')

    const en = buildTourSteps('overview', 'en', document, VIEW)
    const id = buildTourSteps('overview', 'id', document, VIEW)

    expect(id).toHaveLength(en.length)
    expect(id[1].popover?.title).toBe(tourCopy('id').steps['agents-new'].title)
    expect(id[1].popover?.title).not.toBe(en[1].popover?.title)
    // Positioning is a property of the layout, not of the language.
    expect(id[1].popover?.side).toBe(en[1].popover?.side)
  })

  it('keeps each chapter to its own anchors', () => {
    // One anchor from every chapter, all on screen at once — which is not a
    // contrived arrangement: an open agent shows the workspace shell and the
    // chat pane together.
    anchor('nav-rail')
    anchor('pane-close')
    anchor('chat-send')
    anchor('ssh-rail-chat')

    expect(buildTourSteps('workspace', 'en', document, VIEW).map((step) => step.popover?.title)).toEqual([
      tourCopy('en').steps['workspace-intro'].title,
      tourCopy('en').steps['pane-close'].title,
    ])
    expect(buildTourSteps('chat', 'en', document, VIEW).map((step) => step.popover?.title)).toEqual([
      tourCopy('en').steps['chat-intro'].title,
      tourCopy('en').steps['chat-send'].title,
    ])
    expect(buildTourSteps('ssh', 'en', document, VIEW).map((step) => step.popover?.title)).toEqual([
      tourCopy('en').steps['ssh-intro'].title,
      tourCopy('en').steps['ssh-rail-chat'].title,
    ])
  })

  it('narrates whichever half of the SSH chapter is on screen', () => {
    // A connected host: the rail exists, the host list does not.
    anchor('ssh-rail-stats')
    anchor('ssh-chat-new-session')

    const titles = buildTourSteps('ssh', 'en', document, VIEW).map((step) => step.popover?.title)

    expect(titles).toEqual([
      tourCopy('en').steps['ssh-intro'].title,
      tourCopy('en').steps['ssh-chat-new-session'].title,
      tourCopy('en').steps['ssh-rail-stats'].title,
    ])
    expect(titles).not.toContain(tourCopy('en').steps['ssh-new-host'].title)
  })
})

describe('isTourChapterAvailable', () => {
  it('is false for a chapter whose chrome is nowhere on screen', () => {
    anchor('nav-rail')

    expect(isTourChapterAvailable('chat', document, VIEW)).toBe(false)
    expect(isTourChapterAvailable('ssh', document, VIEW)).toBe(false)
  })

  it('is true as soon as one of the chapter’s controls is laid out', () => {
    anchor('chat-input')

    expect(isTourChapterAvailable('chat', document, VIEW)).toBe(true)
  })

  it('does not count an anchor that is present but off-canvas', () => {
    anchor('chat-input', { left: -400, right: -1, width: 400, height: 40, top: 0, bottom: 40 })

    expect(isTourChapterAvailable('chat', document, VIEW)).toBe(false)
  })
})

describe('availableTourChapters', () => {
  it('always offers the overview, even on a screen where none of its anchors resolve', () => {
    expect(availableTourChapters(document, VIEW).overview).toBe(true)
  })

  it('reports the deep chapters honestly', () => {
    anchor('chat-model')

    expect(availableTourChapters(document, VIEW)).toEqual({
      overview: true,
      workspace: false,
      chat: true,
      ssh: false,
    })
  })
})
