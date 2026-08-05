import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Machine, PublishedSOCKSStatus } from '@/store/types'

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
const mockUsePublishedSocks = vi.fn()
const mockMutate = vi.fn()

vi.mock('@/features/data/queries', () => ({
  useMachines: () => mockUseMachines(),
  usePublishedSocks: (machine: Machine | undefined, enabled: boolean) =>
    mockUsePublishedSocks(machine, enabled),
  useSetPublishedSocks: () => ({ mutate: mockMutate, isPending: false }),
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

  it('renders an empty state when no machines are registered', () => {
    mockUseMachines.mockReturnValue({ data: [], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<SocksPublishSection open />)

    expect(screen.getByText(/no machines registered/i)).toBeTruthy()
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
})
