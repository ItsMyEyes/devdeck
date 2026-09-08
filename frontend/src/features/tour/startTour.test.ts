/**
 * `startTour` owns two pieces of state the rest of the feature depends on: the
 * "already seen" flag that decides whether the automatic first run ever fires
 * again, and the active-tour signal HelpFab holds a native-webview occlusion
 * blocker up from. Both are only observable through side effects, so they are
 * pinned here against a stubbed driver.js.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isTourActive, startTour, stopTour, subscribeTourActive } from '@/features/tour/startTour'
import { hasSeenTour, TOUR_SEEN_STORAGE_KEY } from '@/features/tour/tourPrefs'
import { tourCopy } from '@/features/tour/tourCopy'

interface FakeDriver {
  drive: ReturnType<typeof vi.fn>
  destroy: () => void
  isActive: () => boolean
}

const configs: Record<string, unknown>[] = []
const instances: FakeDriver[] = []

vi.mock('driver.js', () => ({
  driver: (config: Record<string, unknown> & { onDestroyed?: () => void }) => {
    configs.push(config)
    const instance: FakeDriver = {
      drive: vi.fn(),
      // The real driver.js calls onDestroyed synchronously from destroy().
      destroy: () => config.onDestroyed?.(),
      isActive: () => true,
    }
    instances.push(instance)
    return instance
  },
}))

beforeEach(() => {
  window.localStorage.clear()
  configs.length = 0
  instances.length = 0
})

afterEach(() => {
  stopTour()
})

describe('startTour', () => {
  it('drives a tour and reports itself active', async () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeTourActive((running) => seen.push(running))

    await startTour('overview', 'en')

    expect(instances[0].drive).toHaveBeenCalledTimes(1)
    expect(isTourActive()).toBe(true)
    expect(seen).toEqual([true])
    unsubscribe()
  })

  it('goes inactive and marks itself seen when the tour ends', async () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeTourActive((running) => seen.push(running))

    await startTour('overview', 'en')
    stopTour()

    expect(isTourActive()).toBe(false)
    expect(seen).toEqual([true, false])
    expect(window.localStorage.getItem(TOUR_SEEN_STORAGE_KEY)).toBe('1')
    unsubscribe()
  })

  it('marks only the chapter that actually ran as seen', async () => {
    await startTour('ssh', 'en')
    stopTour()

    expect(window.localStorage.getItem(`${TOUR_SEEN_STORAGE_KEY}.ssh`)).toBe('1')
    // The unsuffixed key belongs to the overview — the one the automatic first
    // run consults. Watching the SSH tour must not silently consume it.
    expect(window.localStorage.getItem(TOUR_SEEN_STORAGE_KEY)).toBeNull()
    expect(hasSeenTour('ssh')).toBe(true)
    expect(hasSeenTour('overview')).toBe(false)
  })

  it('replaces a running tour rather than stacking a second overlay on it', async () => {
    await startTour('overview', 'en')
    await startTour('overview', 'id')

    expect(instances).toHaveLength(2)
    expect(instances[1].drive).toHaveBeenCalledTimes(1)
    expect(isTourActive()).toBe(true)
  })

  it('hands driver.js the chosen language for its own buttons and progress text', async () => {
    await startTour('overview', 'id')

    const config = configs[0]
    expect(config.nextBtnText).toBe(tourCopy('id').chrome.next)
    expect(config.prevBtnText).toBe(tourCopy('id').chrome.previous)
    expect(config.doneBtnText).toBe(tourCopy('id').chrome.done)
    expect(config.progressText).toBe(tourCopy('id').chrome.progress)
    // Not the English ones — the whole point of the language switch.
    expect(config.nextBtnText).not.toBe(tourCopy('en').chrome.next)
  })

  it('narrates without firing the controls it points at', async () => {
    await startTour('overview', 'en')

    expect(configs[0].disableActiveInteraction).toBe(true)
    expect(configs[0].popoverClass).toBe('devdeck-tour')
  })
})
