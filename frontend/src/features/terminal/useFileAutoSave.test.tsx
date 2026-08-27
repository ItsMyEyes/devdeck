import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

/**
 * The rules auto-save follows, at the hook. Two of them exist specifically to
 * stop an unattended write destroying work — it must not save over a file that
 * changed underneath unsaved edits, and it must not resurrect a draft the
 * operator answered "Don't Save" to — so they are pinned here rather than left
 * to the integration test, which can only reach them through a full pane.
 */

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: (...args: unknown[]) => toastError(...args) } }))

const { useFileAutoSave } = await import('./useFileAutoSave')
const { AUTO_SAVE_STORAGE_KEY } = await import('@/features/editor/useAutoSaveSetting')

type Options = Parameters<typeof useFileAutoSave>[0]

/** The hook's return value, captured for the tests that need to veto a save. */
let discard: () => void = () => {}

function Harness(props: Options) {
  discard = useFileAutoSave(props)
  return null
}

const base: Options = {
  ready: true,
  active: true,
  dirty: false,
  draft: 'v1',
  conflicted: false,
  save: async () => {},
  // The debounce duration is not what these tests are about; a zero delay still
  // goes through a real macrotask, so the trailing behaviour is unchanged.
  delayMs: 0,
}

/** Lets the timer fire and the save's promise chain settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
}

describe('useFileAutoSave', () => {
  beforeEach(() => {
    toastError.mockClear()
    window.localStorage.removeItem(AUTO_SAVE_STORAGE_KEY)
  })

  afterEach(cleanup)

  it('writes the draft once the operator stops typing', async () => {
    const save = vi.fn(async () => {})
    const { rerender } = render(<Harness {...base} save={save} />)

    rerender(<Harness {...base} save={save} dirty draft="edited" />)
    await settle()

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('folds a burst of keystrokes into a single write', async () => {
    const save = vi.fn(async () => {})
    const { rerender } = render(<Harness {...base} save={save} />)

    for (const draft of ['e', 'ed', 'edi', 'edit']) {
      rerender(<Harness {...base} save={save} dirty draft={draft} />)
    }
    await settle()

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('does not write before the file has loaded', async () => {
    const save = vi.fn(async () => {})
    const { rerender } = render(<Harness {...base} save={save} ready={false} />)

    rerender(<Harness {...base} save={save} ready={false} dirty draft="edited" />)
    await settle()

    expect(save).not.toHaveBeenCalled()
  })

  // The rule `fileBuffer.ts` is built on: when the file moved on disk under
  // unsaved edits, nobody picks a winner on the operator's behalf — least of
  // all a timer they did not ask for.
  it('stands down while the file is conflicted', async () => {
    const save = vi.fn(async () => {})
    const { rerender } = render(<Harness {...base} save={save} />)

    rerender(<Harness {...base} save={save} dirty draft="edited" conflicted />)
    await settle()
    act(() => window.dispatchEvent(new Event('blur')))
    await settle()

    expect(save).not.toHaveBeenCalled()
  })

  it('does nothing when the setting is off', async () => {
    window.localStorage.setItem(AUTO_SAVE_STORAGE_KEY, 'false')
    const save = vi.fn(async () => {})
    const { rerender } = render(<Harness {...base} save={save} />)

    rerender(<Harness {...base} save={save} dirty draft="edited" />)
    await settle()

    expect(save).not.toHaveBeenCalled()
  })

  // A background tab is still mounted, so without this the draft would sit
  // behind another tab unwritten — the exact edit that goes missing.
  it('flushes immediately when the tab goes to the back', async () => {
    const save = vi.fn(async () => {})
    const { rerender } = render(<Harness {...base} save={save} delayMs={100_000} />)

    rerender(<Harness {...base} save={save} delayMs={100_000} dirty draft="edited" />)
    rerender(<Harness {...base} save={save} delayMs={100_000} dirty draft="edited" active={false} />)
    await settle()

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flushes immediately when the app loses focus', async () => {
    const save = vi.fn(async () => {})
    const { rerender } = render(<Harness {...base} save={save} delayMs={100_000} />)

    rerender(<Harness {...base} save={save} delayMs={100_000} dirty draft="edited" />)
    act(() => window.dispatchEvent(new Event('blur')))
    await settle()

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flushes on unmount', async () => {
    const save = vi.fn(async () => {})
    const { rerender, unmount } = render(<Harness {...base} save={save} delayMs={100_000} />)

    rerender(<Harness {...base} save={save} delayMs={100_000} dirty draft="edited" />)
    unmount()
    await settle()

    expect(save).toHaveBeenCalledTimes(1)
  })

  // "Don't Save" and "the file was deleted" both unmount a still-dirty tab.
  it('writes nothing after discard, including on unmount', async () => {
    const save = vi.fn(async () => {})
    const { rerender, unmount } = render(<Harness {...base} save={save} delayMs={100_000} />)

    rerender(<Harness {...base} save={save} delayMs={100_000} dirty draft="edited" />)
    act(() => discard())
    unmount()
    await settle()

    expect(save).not.toHaveBeenCalled()
  })

  it('never has two writes to the same path in flight', async () => {
    let release: () => void = () => {}
    const save = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const { rerender } = render(<Harness {...base} save={save} />)

    rerender(<Harness {...base} save={save} dirty draft="edited" />)
    await settle()
    expect(save).toHaveBeenCalledTimes(1)

    // More typing while the first write is still on the wire.
    rerender(<Harness {...base} save={save} dirty draft="edited more" />)
    await settle()
    expect(save).toHaveBeenCalledTimes(1)

    // The queued pass runs once the first one lands, so the later bytes are not
    // dropped and the two writes cannot land out of order.
    await act(async () => {
      release()
    })
    await settle()
    expect(save).toHaveBeenCalledTimes(2)
  })

  // A read-only file or a dropped SSH connection fails every attempt; a toast
  // per typing burst is worse than the failure it reports.
  it('reports a failing streak once, and again after it recovers', async () => {
    let fail = true
    const save = vi.fn(async () => {
      if (fail) throw new Error('permission denied')
    })
    const { rerender } = render(<Harness {...base} save={save} />)

    rerender(<Harness {...base} save={save} dirty draft="a" />)
    await settle()
    rerender(<Harness {...base} save={save} dirty draft="ab" />)
    await settle()
    expect(toastError).toHaveBeenCalledTimes(1)

    fail = false
    rerender(<Harness {...base} save={save} dirty draft="abc" />)
    await settle()
    fail = true
    rerender(<Harness {...base} save={save} dirty draft="abcd" />)
    await settle()

    expect(toastError).toHaveBeenCalledTimes(2)
  })
})
