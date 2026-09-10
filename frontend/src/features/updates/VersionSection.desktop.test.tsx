/**
 * `VersionSection` reconciled with the Tauri updater — the UI section of
 * `docs/superpowers/specs/2026-08-24-desktop-auto-update-design.md`.
 *
 * Two behaviours are load-bearing and pull in opposite directions:
 *  - INSIDE the desktop shell the section must report Tauri's state and offer
 *    the same install action the pill offers, instead of the old "Supervised
 *    by the desktop app" dead end — the update genuinely is installable now;
 *  - OUTSIDE it, nothing may change at all: that path still belongs to
 *    `useMachineUpdateCheck` and the Go runtime's selfupdate (D1), `managed`
 *    409 and all.
 *
 * Lives in `features/updates/` rather than next to the component because
 * `vite.config.ts`'s `test.include` is an explicit list with a glob for this
 * directory and none for `features/overlays/`; the component under test is
 * `@/features/overlays/VersionSection`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MachineBusy, MachineUpdateCheck, MachineVersion } from '@/lib/api'
import type { DesktopUpdate } from '@/features/updates/useDesktopUpdate'

const mockUseMachineVersion = vi.fn()
const mockUseMachineUpdateCheck = vi.fn()
const mockUseMachineBusy = vi.fn()
const mockUseDesktopUpdate = vi.fn<() => DesktopUpdate>()

vi.mock('@/features/data/queries', () => ({
  useMachineVersion: (id: string | undefined) => mockUseMachineVersion(id),
  useMachineUpdateCheck: (id: string | undefined) => mockUseMachineUpdateCheck(id),
  useMachineBusy: (id: string | undefined) => mockUseMachineBusy(id),
}))

vi.mock('@/features/updates/useDesktopUpdate', () => ({
  useDesktopUpdate: () => mockUseDesktopUpdate(),
}))

const { VersionSection } = await import('@/features/overlays/VersionSection')

const SUPERVISED = /Supervised by the desktop app/

const install = vi.fn()

function version(over: Partial<MachineVersion> = {}) {
  return {
    data: { version: '0.2.0', sha256: 'a'.repeat(64), ...over } as MachineVersion,
    isLoading: false,
    isError: false,
  }
}

function check(data: Partial<MachineUpdateCheck> | undefined) {
  return {
    data: data
      ? ({
          current: 'v0.2.0',
          latest: 'v0.2.1',
          updateAvailable: true,
          checksumVerified: 'unknown',
          tokenConfigured: true,
          activeSessions: 0,
          managed: false,
          error: '',
          ...data,
        } as MachineUpdateCheck)
      : undefined,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }
}

function update(over: Partial<DesktopUpdate> = {}): DesktopUpdate {
  return { staged: null, installing: false, checking: false, downloading: false, install, ...over }
}

function busyOk(data: MachineBusy) {
  return { data, isError: false }
}

function busyFailed() {
  return { data: undefined, isError: true }
}

function enterTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
}

beforeEach(() => {
  mockUseMachineVersion.mockReturnValue(version())
  mockUseMachineUpdateCheck.mockReturnValue(check(undefined))
  mockUseMachineBusy.mockReturnValue(busyOk({ terminals: 0, agentRuns: 0 }))
  mockUseDesktopUpdate.mockReturnValue(update())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  // @ts-expect-error the Tauri global only exists inside the desktop webview
  delete window.__TAURI_INTERNALS__
})

describe('VersionSection on the web (unchanged)', () => {
  it('offers the manual check button', () => {
    render(<VersionSection machineId="m1" />)
    expect(screen.getByRole('button', { name: /Check for updates/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Restart & install/ })).toBeNull()
  })

  it('still shows the supervised dead end for a managed runtime', () => {
    mockUseMachineUpdateCheck.mockReturnValue(check({ managed: true }))
    render(<VersionSection machineId="m1" />)
    expect(screen.getByText(SUPERVISED)).toBeInTheDocument()
  })

  it('still reports the check result and the checksum verdict', () => {
    mockUseMachineUpdateCheck.mockReturnValue(check({ checksumVerified: 'match', current: 'v0.2.0' }))
    render(<VersionSection machineId="m1" />)
    expect(screen.getByText(/v0\.2\.1 available/)).toBeInTheDocument()
    expect(screen.getByText(/matches release v0\.2\.0/)).toBeInTheDocument()
  })

  it('never asks the Tauri updater to install', async () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    render(<VersionSection machineId="m1" />)
    expect(screen.queryByRole('button', { name: /Restart & install/ })).toBeNull()
    expect(screen.queryByText(/ready to install/)).toBeNull()
    await Promise.resolve()
    expect(install).not.toHaveBeenCalled()
  })
})

describe('VersionSection inside the desktop shell', () => {
  beforeEach(enterTauri)

  it('replaces the dead end with the Tauri updater state', () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    render(<VersionSection machineId="m1" />)

    expect(screen.queryByText(SUPERVISED)).toBeNull()
    expect(screen.getByText(/v0\.2\.1 ready to install/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Restart & install/ })).toBeInTheDocument()
    // The Go-runtime manual check belongs to separately-launched runtimes (D1).
    expect(screen.queryByRole('button', { name: /Check for updates/ })).toBeNull()
  })

  it('shows no dead end and no install action when nothing is staged', () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: null }))
    render(<VersionSection machineId="m1" />)

    expect(screen.queryByText(SUPERVISED)).toBeNull()
    expect(screen.queryByRole('button', { name: /Restart & install/ })).toBeNull()
    // Nothing to install means nothing a restart would destroy worth asking about.
    expect(mockUseMachineBusy).toHaveBeenCalledWith(undefined)
  })

  it('keeps the build identity block', () => {
    render(<VersionSection machineId="m1" />)
    expect(screen.getByText('SHA256')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy sha256' })).toBeInTheDocument()
  })

  it('installs directly when nothing is running', async () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    mockUseMachineBusy.mockReturnValue(busyOk({ terminals: 0, agentRuns: 0 }))
    render(<VersionSection machineId="m1" />)

    expect(mockUseMachineBusy).toHaveBeenCalledWith('m1')
    await userEvent.click(screen.getByRole('button', { name: /Restart & install/ }))
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('confirms, naming the counts, before installing over live work', async () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    mockUseMachineBusy.mockReturnValue(busyOk({ terminals: 3, agentRuns: 1 }))
    render(<VersionSection machineId="m1" />)

    expect(screen.getByText(/3 terminals · 1 agent running/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Restart & install' }))
    expect(install).not.toHaveBeenCalled()
    expect(screen.getByText(/3 terminals and 1 agent run/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Restart & install anyway' }))
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('confirms, then still installs, when the busy query failed', async () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' } }))
    mockUseMachineBusy.mockReturnValue(busyFailed())
    render(<VersionSection machineId="m1" />)

    expect(screen.getByText(/v0\.2\.1 ready to install/)).toBeInTheDocument()

    // Unknown counts confirm rather than install silently — matching
    // UpdateBanner. A failed advisory query must not be read as "idle".
    await userEvent.click(screen.getByRole('button', { name: 'Restart & install' }))
    expect(install).not.toHaveBeenCalled()
    expect(screen.getByText(/couldn't check what's running/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Restart & install anyway' }))
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('disables the install button while an install is in flight', () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' }, installing: true }))
    render(<VersionSection machineId="m1" />)
    expect(screen.getByRole('button', { name: /install/i })).toBeDisabled()
  })

  // The operator has no other way to learn a background check or download is
  // under way — the pill never renders for either (spec, UI section) — so
  // this is the one place that state is surfaced at all.
  it('shows a loading indicator while a check is in flight', () => {
    mockUseDesktopUpdate.mockReturnValue(update({ checking: true }))
    render(<VersionSection machineId="m1" />)
    expect(screen.getAllByText(/Checking for updates…/).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /Restart & install/ })).toBeNull()
  })

  it('shows a loading indicator while a found update downloads', () => {
    mockUseDesktopUpdate.mockReturnValue(update({ downloading: true }))
    render(<VersionSection machineId="m1" />)
    expect(screen.getAllByText(/Downloading update…/).length).toBeGreaterThan(0)
  })

  it('prefers the staged pill over an in-flight indicator once an update lands', () => {
    mockUseDesktopUpdate.mockReturnValue(update({ staged: { version: '0.2.1' }, checking: true }))
    render(<VersionSection machineId="m1" />)
    expect(screen.queryByText(/Checking for updates…/)).toBeNull()
    expect(screen.getByText(/v0\.2\.1 ready to install/)).toBeInTheDocument()
  })
})
