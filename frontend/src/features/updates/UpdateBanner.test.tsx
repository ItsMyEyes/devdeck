/**
 * The update pill (spec `2026-08-24-desktop-auto-update-design.md`, UI section).
 *
 * The load-bearing behaviours, all of which are easy to regress:
 *  - it renders ONLY once an update is downloaded and staged, so it cannot
 *    flicker on launch while a background check/download is in flight;
 *  - "Later" is scoped to one version and survives a reload (localStorage), so
 *    a newer release re-prompts instead of being permanently silenced;
 *  - the busy counts are advisory — a failed `/machines/{id}/busy` must never
 *    block the update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Machine } from '@/store/types'
import type { MachineBusy } from '@/lib/api'
import type { DesktopUpdate } from '@/features/updates/useDesktopUpdate'

const mockUseDesktopUpdate = vi.fn<() => DesktopUpdate>()
const mockUseMachines = vi.fn()
const mockUseMachineBusy = vi.fn()

vi.mock('@/features/updates/useDesktopUpdate', () => ({
  useDesktopUpdate: () => mockUseDesktopUpdate(),
}))

vi.mock('@/features/data/queries', () => ({
  useMachines: () => mockUseMachines(),
  useMachineBusy: (id: string | undefined) => mockUseMachineBusy(id),
}))

const { UpdateBanner } = await import('@/features/updates/UpdateBanner')

const localMachine: Machine = {
  id: 'local-1',
  name: 'this-mac',
  url: 'http://127.0.0.1:9199',
  key: 'k',
  isLocal: true,
  signingPublicKey: '',
}

const install = vi.fn()

function update(over: Partial<DesktopUpdate> = {}): DesktopUpdate {
  return { staged: null, installing: false, install, ...over }
}

function busyOk(data: MachineBusy) {
  return { data, isError: false }
}

function busyFailed() {
  return { data: undefined, isError: true }
}

beforeEach(() => {
  mockUseMachines.mockReturnValue({ data: [localMachine] })
  mockUseMachineBusy.mockReturnValue(busyOk({ terminals: 0, agentRuns: 0 }))
  mockUseDesktopUpdate.mockReturnValue(update())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.localStorage.clear()
})

describe('UpdateBanner', () => {
  it('renders nothing while no update is staged', () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: null }))
    const { container } = render(<UpdateBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the pill with the new version once an update is staged', () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    render(<UpdateBanner />)
    expect(screen.getByText('v0.2.1 ready to install')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restart & install' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument()
  })

  it('stacks above the TransferStatusPanel rather than overlapping it', () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    const { container } = render(<UpdateBanner />)
    const root = container.firstElementChild as HTMLElement
    // TransferStatusPanel owns `fixed bottom-4 right-4 z-50`; the pill must sit
    // clear of that 4-unit band, not on top of it.
    expect(root.className).toContain('fixed')
    expect(root.className).toContain('right-4')
    expect(root.className).not.toContain('bottom-4')
  })

  it('renders the busy counts', () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    mockUseMachineBusy.mockReturnValue(busyOk({ terminals: 3, agentRuns: 1 }))
    render(<UpdateBanner />)
    expect(screen.getByText('3 terminals · 1 agent running')).toBeInTheDocument()
  })

  it('queries the local machine for the busy counts', () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    mockUseMachines.mockReturnValue({
      data: [{ ...localMachine, id: 'remote-1', isLocal: false }, localMachine],
    })
    render(<UpdateBanner />)
    expect(mockUseMachineBusy).toHaveBeenCalledWith('local-1')
  })

  it('still renders the pill, and still installs, when the busy query failed', async () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    mockUseMachineBusy.mockReturnValue(busyFailed())
    render(<UpdateBanner />)

    expect(screen.getByText('v0.2.1 ready to install')).toBeInTheDocument()
    expect(screen.queryByText(/terminal/)).toBeNull()

    // Unknown counts are NOT "nothing running" — absence of evidence is not
    // evidence of absence, and treating it as such is what would let a silent
    // restart kill a live agent run. So it confirms, saying it cannot say.
    await userEvent.click(screen.getByRole('button', { name: 'Restart & install' }))
    expect(install).not.toHaveBeenCalled()
    expect(screen.getByText(/couldn't check what's running/)).toBeInTheDocument()

    // Still installs on confirm: a broken /busy costs a click, never an update.
    await userEvent.click(screen.getByRole('button', { name: 'Restart & install anyway' }))
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('installs without a confirm step when nothing is running', async () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    mockUseMachineBusy.mockReturnValue(busyOk({ terminals: 0, agentRuns: 0 }))
    render(<UpdateBanner />)

    await userEvent.click(screen.getByRole('button', { name: 'Restart & install' }))
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('confirms, naming the counts, before installing over live work', async () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    mockUseMachineBusy.mockReturnValue(busyOk({ terminals: 3, agentRuns: 1 }))
    render(<UpdateBanner />)

    await userEvent.click(screen.getByRole('button', { name: 'Restart & install' }))
    expect(install).not.toHaveBeenCalled()
    expect(screen.getByText(/3 terminals and 1 agent run/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Restart & install anyway' }))
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('hides on "Later", and a different version re-shows it', async () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    const { rerender } = render(<UpdateBanner />)

    await userEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByText('v0.2.1 ready to install')).toBeNull()

    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.2' } }))
    rerender(<UpdateBanner />)
    expect(screen.getByText('v0.2.2 ready to install')).toBeInTheDocument()
  })

  it('keeps the dismissal across a reload for the same version only', async () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    const first = render(<UpdateBanner />)
    await userEvent.click(screen.getByRole('button', { name: 'Later' }))
    first.unmount()

    // Remount: a fresh component tree, standing in for a page reload.
    render(<UpdateBanner />)
    expect(screen.queryByText('v0.2.1 ready to install')).toBeNull()
    cleanup()

    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.3.0' } }))
    render(<UpdateBanner />)
    expect(screen.getByText('v0.3.0 ready to install')).toBeInTheDocument()
  })

  it('survives localStorage throwing', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    render(<UpdateBanner />)
    expect(screen.getByText('v0.2.1 ready to install')).toBeInTheDocument()
    spy.mockRestore()
  })
})
