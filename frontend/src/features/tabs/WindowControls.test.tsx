import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WindowControls } from './WindowControls'

const minimize = vi.fn().mockResolvedValue(undefined)
const toggleMaximize = vi.fn().mockResolvedValue(undefined)
const close = vi.fn().mockResolvedValue(undefined)
const isMaximized = vi.fn().mockResolvedValue(false)
const onResized = vi.fn().mockResolvedValue(() => {})

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ minimize, toggleMaximize, close, isMaximized, onResized }),
}))

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  minimize.mockResolvedValue(undefined)
  toggleMaximize.mockResolvedValue(undefined)
  close.mockResolvedValue(undefined)
  isMaximized.mockResolvedValue(false)
  onResized.mockResolvedValue(() => {})
})

describe('WindowControls', () => {
  it('renders the three Windows/Linux caption buttons', () => {
    render(<WindowControls />)
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('reflects the real maximized state once the mounted effect resolves it', async () => {
    isMaximized.mockResolvedValue(true)
    render(<WindowControls />)
    // Only flips once `getCurrentWindow().isMaximized()` — the same mocked
    // window instance the click handlers below will call — has resolved
    // through the mount effect, so this doubles as a readiness gate.
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument()
  })

  it('minimize/toggleMaximize/close each call the matching Tauri window command', async () => {
    isMaximized.mockResolvedValue(true)
    render(<WindowControls />)
    await screen.findByRole('button', { name: 'Restore' })

    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(minimize).toHaveBeenCalledTimes(1)
    expect(toggleMaximize).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('WindowControls — failures must be visible', () => {
  // These three buttons ARE the window's title bar on Windows and Linux
  // (`decorations: false`), so when one stops working there is no native
  // fallback to fall back to and no error anywhere: the window simply cannot
  // be closed. Every way that can happen is covered here.

  it('reports a rejected command instead of swallowing it', async () => {
    // What an ACL denial looks like from the frontend. Tauri answers a command
    // the capability does not grant by REJECTING the invoke — unawaited, that
    // is indistinguishable from a dead button, which is how a remote-hub
    // install could look completely broken with nothing logged anywhere.
    minimize.mockRejectedValue(new Error('window.minimize not allowed'))
    render(<WindowControls />)

    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastError.mock.calls[0][0]).toMatch(/minimize/i)
    expect(toastError.mock.calls[0][1]).toMatchObject({ description: expect.stringContaining('not allowed') })
  })

  it('reports a command that throws synchronously', async () => {
    close.mockImplementation(() => {
      throw new Error('IPC unavailable')
    })
    render(<WindowControls />)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastError.mock.calls[0][1]).toMatchObject({ description: expect.stringContaining('IPC unavailable') })
  })

  it('still acts when the mount effect could not read the maximized state', async () => {
    // The regression this shape exists for. The previous revision resolved the
    // window ONCE in the mount effect (behind a dynamic import) and stored it
    // in a ref, so anything that went wrong on that path left the ref null and
    // every button a permanent, silent no-op. Resolving per click means a
    // broken state probe costs the label, not the buttons.
    isMaximized.mockRejectedValue(new Error('is_maximized not allowed'))
    onResized.mockRejectedValue(new Error('event.listen not allowed'))
    render(<WindowControls />)

    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))

    expect(minimize).toHaveBeenCalledTimes(1)
    // ...and the failed probe stays quiet: it is cosmetic, and a toast for it
    // would fire on every mount.
    await waitFor(() => expect(toastError).not.toHaveBeenCalled())
  })
})
