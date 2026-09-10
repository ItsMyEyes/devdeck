/**
 * D6 of `2026-08-24-desktop-auto-update-design.md`: the automatic check runs
 * once on start and every 6 hours, and is skipped entirely outside the Tauri
 * shell or in a dev build. The dev skip is not cosmetic — a dev build reports
 * version `0.1.0` (D4), so without it every `npm run dev` session would be
 * offered "an update" on every launch.
 *
 * The check/download cycle is a module-level singleton, so most of what is
 * asserted here is about state that outlives any one component: two mounted
 * consumers must share one cycle, and a staged payload must never be
 * downloaded twice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import {
  CHECK_INTERVAL_MS,
  isUnstampedBuild,
  shouldCheckForUpdates,
  useDesktopUpdate,
  __resetDesktopUpdateForTests,
} from '@/features/updates/useDesktopUpdate'

const check = vi.fn()
vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => check() }))

/** A fake Tauri `Update` resource. `download`/`close` are spies so the tests
 *  can assert the payload is fetched once and the handle is released. */
function fakeUpdate(version: string, currentVersion = '0.2.0') {
  return {
    version,
    currentVersion,
    body: `notes for ${version}`,
    download: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function Probe() {
  useDesktopUpdate()
  return null
}

/** Puts the module in the one state where the controller actually runs:
 *  inside the Tauri shell, not a dev build. Vitest sets `import.meta.env.DEV`
 *  true by default, which would otherwise short-circuit every check. */
function enterDesktopShell() {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  vi.stubEnv('DEV', false)
}

afterEach(() => {
  cleanup()
  __resetDesktopUpdateForTests()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('shouldCheckForUpdates', () => {
  it('checks only inside the desktop shell, and never in a dev build', () => {
    expect(shouldCheckForUpdates(true, false)).toBe(true)
    expect(shouldCheckForUpdates(true, true)).toBe(false)
    expect(shouldCheckForUpdates(false, false)).toBe(false)
    expect(shouldCheckForUpdates(false, true)).toBe(false)
  })
})

describe('isUnstampedBuild', () => {
  it('recognises the placeholder version CI replaces with the tag', () => {
    // `make dev-tauri-full` and `make e2e-tauri-smoke` build the web UI with a
    // PRODUCTION vite build, so import.meta.env.DEV is false in both while the
    // bundle is still 0.1.0. Without this second guard they would download the
    // real release and offer to install it over a debug build.
    expect(isUnstampedBuild('0.1.0')).toBe(true)
    expect(isUnstampedBuild('0.2.1')).toBe(false)
  })
})

describe('CHECK_INTERVAL_MS', () => {
  it('is six hours', () => {
    expect(CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
  })
})

describe('useDesktopUpdate', () => {
  it('never touches the updater plugin outside the Tauri shell', async () => {
    // jsdom has no `__TAURI_INTERNALS__`, which is exactly the web case.
    expect('__TAURI_INTERNALS__' in window).toBe(false)

    let seen: ReturnType<typeof useDesktopUpdate> | undefined
    function Capture() {
      seen = useDesktopUpdate()
      return null
    }
    render(<Capture />)
    // The check is fired from an effect and would resolve on a microtask.
    await Promise.resolve()

    expect(check).not.toHaveBeenCalled()
    expect(seen?.staged).toBeNull()
    expect(seen?.installing).toBe(false)
  })

  it('runs one shared check cycle no matter how many consumers mount', async () => {
    enterDesktopShell()
    const found = fakeUpdate('0.2.1')
    check.mockResolvedValue(found)

    // Both real consumers: the always-mounted pill and the About panel.
    render(
      <>
        <Probe />
        <Probe />
      </>,
    )
    await waitFor(() => expect(found.download).toHaveBeenCalled())

    // A per-component hook would check and download once per instance, so
    // opening Settings → About would re-fetch the whole release bundle.
    expect(check).toHaveBeenCalledTimes(1)
    expect(found.download).toHaveBeenCalledTimes(1)
  })

  it('does not re-download a version that is already staged', async () => {
    vi.useFakeTimers()
    try {
      enterDesktopShell()
      const found = fakeUpdate('0.2.1')
      check.mockResolvedValue(found)

      render(<Probe />)
      await vi.waitFor(() => expect(found.download).toHaveBeenCalledTimes(1))

      // `check()` keeps reporting 0.2.1 forever: it compares against the
      // INSTALLED version, which does not change until the operator restarts.
      // Without the guard every 6-hour tick re-pulls the full payload.
      const second = fakeUpdate('0.2.1')
      check.mockResolvedValue(second)
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)

      expect(check).toHaveBeenCalledTimes(2)
      expect(second.download).not.toHaveBeenCalled()
      // ...and the redundant handle is released rather than retained.
      expect(second.close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an update offered to an unstamped dev bundle', async () => {
    enterDesktopShell()
    const found = fakeUpdate('0.2.1', '0.1.0')
    check.mockResolvedValue(found)

    render(<Probe />)
    await waitFor(() => expect(found.close).toHaveBeenCalled())

    expect(found.download).not.toHaveBeenCalled()
  })

  // Settings is opened deliberately (unlike the always-mounted pill), so it
  // may surface these two phases without recreating the launch-time flicker
  // the pill avoids by never rendering for either.
  it('reports checking while check() is in flight, then downloading while the payload is fetched', async () => {
    enterDesktopShell()
    const found = fakeUpdate('0.2.1')
    let resolveDownload: () => void = () => {}
    found.download.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve
        }),
    )
    let resolveCheck: (u: typeof found) => void = () => {}
    check.mockImplementation(() => new Promise((resolve) => (resolveCheck = resolve)))

    let seen: ReturnType<typeof useDesktopUpdate> | undefined
    function Capture() {
      seen = useDesktopUpdate()
      return null
    }
    render(<Capture />)

    await waitFor(() => expect(seen?.checking).toBe(true))
    expect(seen?.downloading).toBe(false)

    resolveCheck(found)
    await waitFor(() => expect(seen?.downloading).toBe(true))
    expect(seen?.checking).toBe(false)

    resolveDownload()
    await waitFor(() => expect(seen?.downloading).toBe(false))
    expect(seen?.staged).toEqual({ version: '0.2.1', notes: 'notes for 0.2.1' })
  })

  it('clears checking without ever setting downloading when no update is found', async () => {
    enterDesktopShell()
    check.mockResolvedValue(null)

    let seen: ReturnType<typeof useDesktopUpdate> | undefined
    function Capture() {
      seen = useDesktopUpdate()
      return null
    }
    render(<Capture />)

    await waitFor(() => expect(seen?.checking).toBe(false))
    expect(seen?.downloading).toBe(false)
  })
})
