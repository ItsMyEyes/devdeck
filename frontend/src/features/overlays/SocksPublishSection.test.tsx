import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Machine, PublishedSOCKSStatus, Whoami } from '@/store/types'

// jsdom has no PointerEvent — @base-ui/react's Switch.Root dispatches one
// from its onClick handler unconditionally. Stub it so `.click()` on the
// switch doesn't throw (same pattern as ShellSidebar.test.tsx).
if (typeof window.PointerEvent === 'undefined') {
  class FakePointerEvent extends MouseEvent {
    pointerId: number
    constructor(type: string, params: MouseEventInit & { pointerId?: number } = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 0
    }
  }
  // @ts-expect-error jsdom doesn't implement PointerEvent
  window.PointerEvent = FakePointerEvent
}

const mockUseMachines = vi.fn()
const mockUseWhoami = vi.fn()
const mockUsePublishedSocks = vi.fn()
const mockUseLocalPublishedSocks = vi.fn()
const mockUseSetPublishedSocks = vi.fn()
const mockUseSetLocalPublishedSocks = vi.fn()
const mockMutate = vi.fn()
const mockLocalMutate = vi.fn()

vi.mock('@/features/data/queries', () => ({
  useMachines: () => mockUseMachines(),
  useWhoami: () => mockUseWhoami(),
  usePublishedSocks: (machine: Machine | undefined, enabled: boolean) =>
    mockUsePublishedSocks(machine, enabled),
  useSetPublishedSocks: () => mockUseSetPublishedSocks(),
  useLocalPublishedSocks: (enabled: boolean) => mockUseLocalPublishedSocks(enabled),
  useSetLocalPublishedSocks: () => mockUseSetLocalPublishedSocks(),
}))

const { SocksPublishSection } = await import('./SocksPublishSection')

const machine: Machine = {
  id: 'm1',
  name: 'prod-runtime',
  url: 'http://runtime:9199',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

function status(over: Partial<PublishedSOCKSStatus> = {}): PublishedSOCKSStatus {
  return { enabled: false, port: 1080, running: false, key: '', ...over }
}

function whoami(over: Partial<Whoami> = {}): Whoami {
  return {
    status: 'ok',
    role: 'hub',
    machineName: 'hub-laptop',
    lastSyncedAt: null,
    hubUrl: '',
    machineId: '',
    ...over,
  }
}

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

beforeEach(() => {
  mockUseWhoami.mockReturnValue({ data: whoami(), isLoading: false, error: null })
  mockUseLocalPublishedSocks.mockReturnValue({ data: status(), isLoading: false, error: null })
  mockUseSetPublishedSocks.mockReturnValue({ mutate: mockMutate, isPending: false })
  mockUseSetLocalPublishedSocks.mockReturnValue({ mutate: mockLocalMutate, isPending: false })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SocksPublishSection', () => {
  it('renders a loading state while machines are loading', () => {
    mockUseMachines.mockReturnValue({ data: undefined, isLoading: true, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: undefined, isLoading: true, error: null })

    render(<SocksPublishSection open />)

    expect(screen.getByText(/loading/i)).toBeTruthy()
  })

  it('renders an empty state when no other machines are registered', () => {
    mockUseMachines.mockReturnValue({ data: [], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<SocksPublishSection open />)

    expect(screen.getByText(/no other machines registered/i)).toBeTruthy()
  })

  it('renders an error state when the machine list fails', () => {
    mockUseMachines.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') })
    mockUsePublishedSocks.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<SocksPublishSection open />)

    expect(screen.getByText(/boom/i)).toBeTruthy()
  })

  it('masks the key until revealed', async () => {
    mockUseMachines.mockReturnValue({ data: [machine], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({
      data: status({ enabled: true, running: true, key: 'secret-key-value', url: 'socks5://devdeck:secret-key-value@runtime:1080' }),
      isLoading: false,
      error: null,
    })

    render(<SocksPublishSection open />)

    expect(screen.queryByText('secret-key-value')).toBeNull()
    const reveal = screen.getByRole('button', { name: /show socks5 key/i })
    reveal.click()
    expect(await screen.findByText('secret-key-value')).toBeTruthy()
  })

  it('toggling on sends enabled:true with the machine', () => {
    mockUseMachines.mockReturnValue({ data: [machine], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: status(), isLoading: false, error: null })

    render(<SocksPublishSection open />)
    screen.getByRole('switch', { name: /publish socks5 on prod-runtime/i }).click()

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({ machine, body: expect.objectContaining({ enabled: true }) }),
    )
  })

  // ---- Port (gap 1: an unconfigurable machine when 1080 is taken) ----

  it('sends the edited port when toggling on', () => {
    mockUseMachines.mockReturnValue({ data: [machine], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: status(), isLoading: false, error: null })

    render(<SocksPublishSection open />)
    fireEvent.change(screen.getByLabelText(/socks5 port on prod-runtime/i), { target: { value: '1081' } })
    screen.getByRole('switch', { name: /publish socks5 on prod-runtime/i }).click()

    expect(mockMutate).toHaveBeenCalledWith({ machine, body: { enabled: true, port: 1081 } })
  })

  it('applies the port on Enter without changing enabled state', () => {
    mockUseMachines.mockReturnValue({ data: [machine], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: status({ enabled: true, running: true, key: 'k' }), isLoading: false, error: null })

    render(<SocksPublishSection open />)
    const input = screen.getByLabelText(/socks5 port on prod-runtime/i)
    fireEvent.change(input, { target: { value: '1081' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mockMutate).toHaveBeenCalledWith({ machine, body: { enabled: true, port: 1081 } })
  })

  it('rejects an out-of-range port instead of sending it', () => {
    mockUseMachines.mockReturnValue({ data: [machine], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: status(), isLoading: false, error: null })

    render(<SocksPublishSection open />)
    const input = screen.getByLabelText(/socks5 port on prod-runtime/i)
    fireEvent.change(input, { target: { value: '99999' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mockMutate).not.toHaveBeenCalled()
    expect(screen.getByText(/1–65535/)).toBeTruthy()
  })

  it('disables the port input while a mutation is in flight', () => {
    mockUseMachines.mockReturnValue({ data: [machine], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: status(), isLoading: false, error: null })
    mockUseSetPublishedSocks.mockReturnValue({ mutate: mockMutate, isPending: true })

    render(<SocksPublishSection open />)

    expect((screen.getByLabelText(/socks5 port on prod-runtime/i) as HTMLInputElement).disabled).toBe(true)
  })

  // ---- Self row (gap 2: the hub is absent from its own registry) ----

  it('renders a row for the process serving the page, labelled from whoami', () => {
    mockUseMachines.mockReturnValue({ data: [], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<SocksPublishSection open />)

    expect(screen.getByText('hub-laptop')).toBeTruthy()
    expect(screen.getByRole('switch', { name: /publish socks5 on hub-laptop/i })).toBeTruthy()
  })

  it('falls back to "This machine" when whoami has no machine name', () => {
    mockUseWhoami.mockReturnValue({ data: whoami({ machineName: '' }), isLoading: false, error: null })
    mockUseMachines.mockReturnValue({ data: [], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<SocksPublishSection open />)

    expect(screen.getByText('This machine')).toBeTruthy()
  })

  it('toggling the self row goes through the local mutation, not a machine one', () => {
    mockUseMachines.mockReturnValue({ data: [], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<SocksPublishSection open />)
    screen.getByRole('switch', { name: /publish socks5 on hub-laptop/i }).click()

    expect(mockLocalMutate).toHaveBeenCalledWith({ enabled: true, port: 1080 })
    expect(mockMutate).not.toHaveBeenCalled()
  })

  it('does not list a registered machine twice when it is this process', () => {
    mockUseWhoami.mockReturnValue({
      data: whoami({ role: 'runtime', machineName: 'prod-runtime', machineId: 'm1' }),
      isLoading: false,
      error: null,
    })
    mockUseMachines.mockReturnValue({ data: [machine], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: status(), isLoading: false, error: null })

    render(<SocksPublishSection open />)

    expect(screen.getAllByRole('switch', { name: /publish socks5 on prod-runtime/i })).toHaveLength(1)
  })

  // ---- Key row visibility (gap 4: enabled but not running after a failed bind) ----

  it('shows the key row and a failure hint when enabled but not running', () => {
    mockUseMachines.mockReturnValue({ data: [machine], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({
      data: status({ enabled: true, running: false, key: 'stale-key' }),
      isLoading: false,
      error: null,
    })

    render(<SocksPublishSection open />)

    expect(screen.getByRole('button', { name: /copy socks5 url for prod-runtime/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /rotate socks5 key on prod-runtime/i })).toBeTruthy()
    expect(screen.getByText(/not listening/i)).toBeTruthy()
  })

  // ---- Copy ----

  it('copies the full socks5 URL for a machine row', () => {
    const writeText = stubClipboard()
    const url = 'socks5://devdeck:secret-key-value@runtime:1080'
    mockUseMachines.mockReturnValue({ data: [machine], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({
      data: status({ enabled: true, running: true, key: 'secret-key-value', url }),
      isLoading: false,
      error: null,
    })

    render(<SocksPublishSection open />)
    screen.getByRole('button', { name: /copy socks5 url for prod-runtime/i }).click()

    expect(writeText).toHaveBeenCalledWith(url)
  })

  it('copies the full socks5 URL for the self row', () => {
    const writeText = stubClipboard()
    const url = 'socks5://devdeck:local-key-value@hub-laptop:1080'
    mockUseMachines.mockReturnValue({ data: [], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: undefined, isLoading: false, error: null })
    mockUseLocalPublishedSocks.mockReturnValue({
      data: status({ enabled: true, running: true, key: 'local-key-value', url }),
      isLoading: false,
      error: null,
    })

    render(<SocksPublishSection open />)
    screen.getByRole('button', { name: /copy socks5 url for hub-laptop/i }).click()

    expect(writeText).toHaveBeenCalledWith(url)
  })
})
