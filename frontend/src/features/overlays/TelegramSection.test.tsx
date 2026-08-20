/**
 * Task 7 (docs/superpowers/plans/2026-08-18-telegram-remote-chat.md): settings
 * panel for ONE machine's Telegram bridge, sitting beside `SocksPublishSection`
 * and matching its visual language / TanStack Query usage. Unlike Socks it does
 * not enumerate self+registered-machines itself — it is scoped to a single
 * `machine` prop (see the doc comment on `TelegramSection.tsx`).
 *
 * Mirrors `SocksPublishSection.test.tsx`'s shim + hook-mocking approach, but the
 * hooks mocked here live in `@/lib/telegramApi` (co-located with the raw fetch
 * wrappers) rather than `@/features/data/queries`, because Task 7's file list
 * does not include `queries.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Machine, TelegramConfig, TelegramUser } from '@/store/types'

// jsdom has no PointerEvent — @base-ui/react's Switch.Root dispatches one
// from its onClick handler unconditionally. Stub it so `.click()` on the
// switch doesn't throw (same pattern as SocksPublishSection.test.tsx).
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

const mockUseTelegramConfig = vi.fn()
const mockUseTelegramUsers = vi.fn()
const mockUseSetTelegramConfig = vi.fn()
const mockUseCreatePairingCode = vi.fn()
const mockUseDeleteTelegramUser = vi.fn()
const mockSetConfigMutate = vi.fn()
const mockPairMutate = vi.fn()
const mockDeleteUserMutate = vi.fn()

vi.mock('@/lib/telegramApi', () => ({
  useTelegramConfig: (machine: unknown, enabled: unknown) => mockUseTelegramConfig(machine, enabled),
  useTelegramUsers: (machine: unknown, enabled: unknown, refetchIntervalMs: unknown) =>
    mockUseTelegramUsers(machine, enabled, refetchIntervalMs),
  useSetTelegramConfig: (machine: unknown) => mockUseSetTelegramConfig(machine),
  useCreatePairingCode: (machine: unknown) => mockUseCreatePairingCode(machine),
  useDeleteTelegramUser: (machine: unknown) => mockUseDeleteTelegramUser(machine),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

// `TelegramPublishSection` composes its rows from the machine registry the
// same way `SocksPublishSection` does. Only these two hooks are reached from
// this file, so a factory stub is enough.
const mockUseMachines = vi.fn()
const mockUseWhoami = vi.fn()
// Defaults to "this build advertises the Telegram capability", so the
// pre-existing tests below exercise a supported machine without each having
// to say so. The capability-gate tests override it.
const mockUseMachineCapabilities = vi.fn(
  (_m: unknown): { data: string[] | null | undefined; isError: boolean } => ({ data: ['telegram'], isError: false }),
)
vi.mock('@/features/data/queries', () => ({
  useMachines: (enabled: unknown) => mockUseMachines(enabled),
  useWhoami: () => mockUseWhoami(),
  useMachineCapabilities: (m: unknown) => mockUseMachineCapabilities(m),
}))

const { TelegramSection, TelegramPublishSection } = await import('./TelegramSection')

const machine: Machine = {
  id: 'm1',
  name: 'prod-runtime',
  url: 'http://runtime:9199',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

function config(over: Partial<TelegramConfig> = {}): TelegramConfig {
  return { enabled: false, hasToken: false, botUsername: '', ...over }
}

function user(over: Partial<TelegramUser> = {}): TelegramUser {
  return { userId: 587442310, label: '@kiyora', addedAt: 1000, ...over }
}

beforeEach(() => {
  mockUseTelegramConfig.mockReturnValue({ data: config(), isLoading: false, error: null })
  mockUseTelegramUsers.mockReturnValue({ data: [], isLoading: false, error: null })
  mockUseSetTelegramConfig.mockReturnValue({ mutate: mockSetConfigMutate, isPending: false })
  mockUseCreatePairingCode.mockReturnValue({ mutate: mockPairMutate, isPending: false })
  mockUseDeleteTelegramUser.mockReturnValue({ mutate: mockDeleteUserMutate, isPending: false })
  mockUseMachines.mockReturnValue({ data: [], isLoading: false, error: null })
  mockUseWhoami.mockReturnValue({ data: { machineId: '', machineName: 'hub-01' }, isLoading: false, error: null })
  mockUseMachineCapabilities.mockReturnValue({ data: ['telegram'], isError: false })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TelegramSection', () => {
  it('renders a loading state while the config is loading', () => {
    mockUseTelegramConfig.mockReturnValue({ data: undefined, isLoading: true, error: null })

    render(<TelegramSection machine={machine} name={machine.name} open />)

    expect(screen.getByText(/loading/i)).toBeTruthy()
  })

  it('renders an error state when the config fails to load', () => {
    mockUseTelegramConfig.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') })

    render(<TelegramSection machine={machine} name={machine.name} open />)

    expect(screen.getByText(/boom/i)).toBeTruthy()
  })

  // ---- Token field (gap: the raw token must never appear on screen) ----

  it('renders the token input as a password field', () => {
    render(<TelegramSection machine={machine} name={machine.name} open />)

    const input = screen.getByLabelText(/telegram bot token/i) as HTMLInputElement
    expect(input.type).toBe('password')
  })

  it('shows a "tersimpan" state instead of the value when hasToken is true', () => {
    mockUseTelegramConfig.mockReturnValue({ data: config({ hasToken: true }), isLoading: false, error: null })

    render(<TelegramSection machine={machine} name={machine.name} open />)

    const input = screen.getByLabelText(/telegram bot token/i) as HTMLInputElement
    // The backend never serializes the token — the UI cannot show it even if
    // it wanted to — so the field must render empty, not a stand-in value.
    expect(input.value).toBe('')
    expect(screen.getByText(/tersimpan/i)).toBeTruthy()
  })

  it('shows no "tersimpan" state when no token is stored', () => {
    mockUseTelegramConfig.mockReturnValue({ data: config({ hasToken: false }), isLoading: false, error: null })

    render(<TelegramSection machine={machine} name={machine.name} open />)

    expect(screen.queryByText(/tersimpan/i)).toBeNull()
  })

  // ---- The "keep the stored one" contract (Task 6) ----

  it('submitting with the token field untouched sends token: ""', () => {
    mockUseTelegramConfig.mockReturnValue({ data: config({ enabled: true, hasToken: true }), isLoading: false, error: null })

    render(<TelegramSection machine={machine} name={machine.name} open />)
    fireEvent.click(screen.getByRole('button', { name: /simpan/i }))

    expect(mockSetConfigMutate).toHaveBeenCalledWith(
      expect.objectContaining({ token: '' }),
      expect.anything(),
    )
  })

  it('submitting a whitespace-only token sends token: "" rather than erasing the stored one', () => {
    mockUseTelegramConfig.mockReturnValue({ data: config({ enabled: true, hasToken: true }), isLoading: false, error: null })

    render(<TelegramSection machine={machine} name={machine.name} open />)
    fireEvent.change(screen.getByLabelText(/telegram bot token/i), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: /simpan/i }))

    // The backend's only test for "unchanged" is `token != ""`, so sending
    // "   " would overwrite a working bot token with whitespace.
    expect(mockSetConfigMutate).toHaveBeenCalledWith(
      expect.objectContaining({ token: '' }),
      expect.anything(),
    )
  })

  it('submitting with a typed token sends the typed value', () => {
    render(<TelegramSection machine={machine} name={machine.name} open />)

    fireEvent.change(screen.getByLabelText(/telegram bot token/i), { target: { value: '123456:AAH' } })
    fireEvent.click(screen.getByRole('button', { name: /simpan/i }))

    expect(mockSetConfigMutate).toHaveBeenCalledWith(
      expect.objectContaining({ token: '123456:AAH' }),
      expect.anything(),
    )
  })

  it('toggling the switch submits the current enabled state', () => {
    render(<TelegramSection machine={machine} name={machine.name} open />)

    fireEvent.click(screen.getByRole('switch', { name: /enable telegram bridge/i }))

    expect(mockSetConfigMutate).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
      expect.anything(),
    )
  })

  // ---- Pairing ----

  it('clicking "Buat kode pairing" renders the returned 6-digit code', () => {
    mockUseCreatePairingCode.mockReturnValue({
      mutate: (_vars: unknown, opts: { onSuccess?: (result: { code: string; expiresAt: string }) => void }) =>
        opts.onSuccess?.({ code: '482913', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }),
      isPending: false,
    })

    render(<TelegramSection machine={machine} name={machine.name} open />)
    fireEvent.click(screen.getByRole('button', { name: /buat kode pairing/i }))

    expect(screen.getByText('482913')).toBeTruthy()
  })

  it('keeps the code on screen when the machine reports an already-past expiry', () => {
    // A machine whose clock runs behind the browser's. The code is live as
    // far as the server is concerned; hiding it strands the operator with no
    // way to enrol, since /pair is the only enrolment path there is.
    mockUseCreatePairingCode.mockReturnValue({
      mutate: (_vars: unknown, opts: { onSuccess?: (result: { code: string; expiresAt: string }) => void }) =>
        opts.onSuccess?.({ code: '482913', expiresAt: new Date(Date.now() - 60_000).toISOString() }),
      isPending: false,
    })

    render(<TelegramSection machine={machine} name={machine.name} open />)
    fireEvent.click(screen.getByRole('button', { name: /buat kode pairing/i }))

    expect(screen.getByText('482913')).toBeTruthy()
  })

  it('polls the allowlist only while a pairing code is live', () => {
    mockUseCreatePairingCode.mockReturnValue({
      mutate: (_vars: unknown, opts: { onSuccess?: (result: { code: string; expiresAt: string }) => void }) =>
        opts.onSuccess?.({ code: '482913', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }),
      isPending: false,
    })

    render(<TelegramSection machine={machine} name={machine.name} open />)

    // Enrolment happens on the Telegram side, so nothing in this app can
    // invalidate the allowlist when it succeeds — without a poll the panel
    // still reads "No paired users yet" after a successful /pair.
    expect(mockUseTelegramUsers).toHaveBeenLastCalledWith(machine, true, undefined)

    fireEvent.click(screen.getByRole('button', { name: /buat kode pairing/i }))

    const [, , interval] = mockUseTelegramUsers.mock.lastCall ?? []
    expect(typeof interval).toBe('number')
    expect(interval as number).toBeGreaterThan(0)
  })

  // ---- Allowlist ----

  it('renders an empty allowlist state', () => {
    render(<TelegramSection machine={machine} name={machine.name} open />)
    expect(screen.getByText(/no paired users/i)).toBeTruthy()
  })

  it('renders each allowlisted user with a remove action', () => {
    mockUseTelegramUsers.mockReturnValue({ data: [user()], isLoading: false, error: null })

    render(<TelegramSection machine={machine} name={machine.name} open />)

    expect(screen.getByText('@kiyora')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /remove @kiyora/i }))
    expect(mockDeleteUserMutate).toHaveBeenCalledWith(587442310, expect.anything())
  })

  // ---- In-UI tutorial (getting a bot token) ----

  it('renders a "Cara mendapatkan token" tutorial next to the token field, with the privacy-mode warning and /setprivacy', () => {
    render(<TelegramSection machine={machine} name={machine.name} open />)

    expect(screen.getByText(/cara mendapatkan token/i)).toBeTruthy()
    // The load-bearing gotcha: BotFather's default privacy mode silently
    // swallows ordinary group prompts (only slash commands get through), and
    // the fix is /setprivacy → Disable. This must not be missing or buried.
    // "privacy mode" legitimately appears more than once (the callout heading,
    // the <em> emphasis, and inline prose), so assert presence via
    // getAllByText rather than the single-match getByText.
    expect(screen.getAllByText(/privacy mode/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/\/setprivacy/)).toBeTruthy()
  })

  it('names the row after the machine, not after the bot', () => {
    mockUseTelegramConfig.mockReturnValue({ data: config({ botUsername: 'devdeck_bot' }), isLoading: false, error: null })

    render(<TelegramSection machine={machine} name="prod-runtime" open />)

    // Several rows stack in `TelegramPublishSection`; the machine name is the
    // only thing that tells them apart before a token has ever been saved.
    expect(screen.getByText('prod-runtime')).toBeTruthy()
    expect(screen.getByText(/devdeck_bot/)).toBeTruthy()
  })
})

/**
 * The section as the settings dialog mounts it: this process's own row plus
 * one per *other* registered runtime, mirroring `SocksPublishSection`.
 */
describe('TelegramPublishSection', () => {
  /** Every target `useTelegramConfig` was called with this render. */
  function configTargets(): unknown[] {
    return mockUseTelegramConfig.mock.calls.map(([target]) => target)
  }

  // The regression guard for the gap this whole section closes: before it
  // existed, `TelegramSection` was never mounted anywhere and there was no
  // way to enter a bot token at all. A hub has no Machine record, so if the
  // self row is ever dropped again this is the test that fails.
  it('always renders a row for the process serving this page', () => {
    mockUseMachines.mockReturnValue({ data: [], isLoading: false, error: null })

    render(<TelegramPublishSection open />)

    expect(screen.getByText('hub-01')).toBeTruthy()
    // Addressed with `null`, not with a fabricated Machine: a --role hub has
    // no registry entry to address, and this row is the only way to configure
    // the process that owns its ssh:* threads.
    expect(configTargets()).toContain(null)
  })

  it('renders the self row and one row per other registered machine', () => {
    mockUseMachines.mockReturnValue({
      data: [
        { ...machine, id: 'm1', name: 'prod-runtime' },
        { ...machine, id: 'm2', name: 'build-runtime' },
      ],
      isLoading: false,
      error: null,
    })

    render(<TelegramPublishSection open />)

    expect(screen.getByText('hub-01')).toBeTruthy()
    expect(screen.getByText('prod-runtime')).toBeTruthy()
    expect(screen.getByText('build-runtime')).toBeTruthy()
    expect(configTargets()).toHaveLength(3)
  })

  it('does not render a self-registered runtime twice', () => {
    // A runtime that registered itself IS in the list; the self row already
    // covers it, so rendering both would give one machine two switches that
    // fight over the same token.
    mockUseWhoami.mockReturnValue({ data: { machineId: 'm1', machineName: 'prod-runtime' }, isLoading: false, error: null })
    mockUseMachines.mockReturnValue({
      data: [{ ...machine, id: 'm1', name: 'prod-runtime' }],
      isLoading: false,
      error: null,
    })

    render(<TelegramPublishSection open />)

    expect(screen.getAllByText('prod-runtime')).toHaveLength(1)
    expect(configTargets()).toEqual([null])
  })

  it('renders loading, error and empty states for the machine registry', () => {
    mockUseMachines.mockReturnValue({ data: undefined, isLoading: true, error: null })
    const { unmount } = render(<TelegramPublishSection open />)
    expect(screen.getByText(/loading machines/i)).toBeTruthy()
    unmount()

    mockUseMachines.mockReturnValue({ data: undefined, isLoading: false, error: new Error('registry down') })
    const second = render(<TelegramPublishSection open />)
    expect(screen.getByText(/registry down/i)).toBeTruthy()
    second.unmount()

    mockUseMachines.mockReturnValue({ data: [], isLoading: false, error: null })
    render(<TelegramPublishSection open />)
    expect(screen.getByText(/no other machines registered/i)).toBeTruthy()
  })

  it('gates every fetch on the section being open', () => {
    render(<TelegramPublishSection open={false} />)

    // A closed settings dialog must not pull bot tokens or allowlists.
    expect(mockUseTelegramConfig).toHaveBeenCalledWith(null, false)
    expect(mockUseMachines).toHaveBeenCalledWith(false)
  })

  // A hub never self-registers, so `whoami.machineId` is EMPTY and the id
  // comparison can never drop anything. A desktop hub DOES register itself as
  // a local machine, though — so without the isLocal signal the same process
  // rendered twice: once as the self row, once as that machine record. Both
  // rows offered to configure the same bot token.
  it('does not render the local machine twice when the page is served by a hub', () => {
    const localSelf: Machine = { ...machine, id: 'm-local', name: 'MacBook-Pro-kiyora.local', isLocal: true }
    mockUseMachines.mockReturnValue({ data: [localSelf], isLoading: false, error: null })
    mockUseWhoami.mockReturnValue({
      data: { machineId: '', machineName: 'MacBook-Pro-kiyora.local' },
      isLoading: false,
      error: null,
    })

    render(<TelegramPublishSection open />)

    expect(screen.getAllByText('MacBook-Pro-kiyora.local')).toHaveLength(1)
    expect(configTargets()).toEqual([null])
  })

  // A remote machine that merely happens to be flagged local elsewhere must
  // still get its own row when this page is served by a RUNTIME that knows
  // its own id — there the id comparison is the accurate signal.
  it('keeps other machines when the page is served by a registered runtime', () => {
    mockUseMachines.mockReturnValue({ data: [machine], isLoading: false, error: null })
    mockUseWhoami.mockReturnValue({
      data: { machineId: 'm-someone-else', machineName: 'runtime-01' },
      isLoading: false,
      error: null,
    })

    render(<TelegramPublishSection open />)

    expect(screen.getAllByText('prod-runtime')).toHaveLength(1)
  })
})

describe('TelegramSection capability gate', () => {
  // The regression: a runtime older than this feature has no /api/telegram/*
  // route, so the request lands on the SPA's index.html and the client
  // reported "JSON Parse error: Unrecognized token '<'" next to the machine
  // name — the parser's problem, not the operator's.
  it('tells the operator to update an out-of-date runtime instead of showing a parse error', () => {
    mockUseMachineCapabilities.mockReturnValue({ data: ['ssh-chat'], isError: false })

    render(<TelegramSection machine={machine} name="home-laptop" open />)

    expect(screen.getByText(/build lama/i)).toBeTruthy()
    expect(screen.queryByText(/JSON Parse error/i)).toBeNull()
  })

  // A build that predates capability reporting entirely reports no list at
  // all. For a feature this new that is conclusive, not ambiguous.
  it('treats a missing capability list as an out-of-date build', () => {
    mockUseMachineCapabilities.mockReturnValue({ data: null, isError: false })

    render(<TelegramSection machine={machine} name="home-laptop" open />)

    expect(screen.getByText(/build lama/i)).toBeTruthy()
  })

  // Unreachable is a different problem with a different fix, and must not be
  // reported as an old build.
  it('distinguishes an unreachable machine from an out-of-date one', () => {
    mockUseMachineCapabilities.mockReturnValue({ data: undefined, isError: true })

    render(<TelegramSection machine={machine} name="home-laptop" open />)

    expect(screen.getByText(/tidak bisa dihubungi/i)).toBeTruthy()
    expect(screen.queryByText(/build lama/i)).toBeNull()
  })

  // No request may be issued at all to a machine that cannot serve it —
  // that request is what produced the parse error in the first place.
  it('does not fetch config from a machine that cannot serve it', () => {
    mockUseMachineCapabilities.mockReturnValue({ data: ['ssh-chat'], isError: false })

    render(<TelegramSection machine={machine} name="home-laptop" open />)

    expect(mockUseTelegramConfig).toHaveBeenCalledWith(machine, false)
  })
})

describe('TelegramSection bridge health', () => {
  // The bug this surface exists for: the bot answered nothing, and the panel
  // showed a healthy-looking @username because getMe succeeds against a token
  // whose getUpdates is refused outright.
  it('shows why the bridge is receiving nothing', () => {
    mockUseTelegramConfig.mockReturnValue({
      data: config({
        enabled: true,
        hasToken: true,
        botUsername: 'JunoyuBot',
        health: 'error',
        healthDetail: 'webhook aktif di https://ai.kiyora.dev/webhook/abc — Telegram menolak getUpdates',
      }),
      isLoading: false,
      error: null,
    })

    render(<TelegramSection machine={null} name="hub-01" open />)

    expect(screen.getByText('tidak menerima pesan')).toBeTruthy()
    expect(screen.getByText(/webhook aktif di/i)).toBeTruthy()
  })

  it('reports a working bridge', () => {
    mockUseTelegramConfig.mockReturnValue({
      data: config({ enabled: true, hasToken: true, health: 'ok' }),
      isLoading: false,
      error: null,
    })

    render(<TelegramSection machine={null} name="hub-01" open />)

    expect(screen.getByText('menerima pesan')).toBeTruthy()
  })

  // An older backend omits the field. Showing nothing is right — its silence
  // is not a claim in either direction.
  it('shows no status at all when the backend does not report one', () => {
    mockUseTelegramConfig.mockReturnValue({
      data: config({ enabled: true, hasToken: true }),
      isLoading: false,
      error: null,
    })

    render(<TelegramSection machine={null} name="hub-01" open />)

    expect(screen.queryByText('menerima pesan')).toBeNull()
    expect(screen.queryByText('tidak menerima pesan')).toBeNull()
    expect(screen.queryByText('menyambung…')).toBeNull()
  })
})
