import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WindowControls } from './WindowControls'

const minimize = vi.fn().mockResolvedValue(undefined)
const toggleMaximize = vi.fn().mockResolvedValue(undefined)
const close = vi.fn().mockResolvedValue(undefined)
const isMaximized = vi.fn().mockResolvedValue(false)
const onResized = vi.fn().mockResolvedValue(() => {})

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ minimize, toggleMaximize, close, isMaximized, onResized }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  isMaximized.mockResolvedValue(false)
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
