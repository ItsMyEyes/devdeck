/**
 * Task 7 (docs/superpowers/plans/2026-08-18-telegram-remote-chat.md): header
 * button that publishes the CURRENT thread to Telegram (or offers to
 * unpublish it, once bound). Lives in `ChatHeader.tsx`'s actions row.
 *
 * §2a of the plan replaced the old chatId/topicId form (unusable — Telegram's
 * UI never shows those numbers) with `/init <threadId>`: the operator copies
 * that command, sends it in the destination chat or forum topic, and the
 * backend bridge reads `chat.id`/`message_thread_id` off that very message
 * and writes the binding. This dialog's only job is to show the command,
 * copy it, and poll the binding list until the bridge's write lands.
 *
 * Mocks `@/lib/telegramApi`'s hooks the same way `TelegramSection.test.tsx`
 * and `SessionsPanel.test.tsx` mock their data-fetching layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Machine, TelegramBinding, TelegramConfig, Workspace } from '@/store/types'

const mockUseTelegramBindings = vi.fn()
const mockUseDeleteTelegramBinding = vi.fn()
const mockUseTelegramConfig = vi.fn()
const mockDeleteBindingMutate = vi.fn()

// Spread-over-the-real-module rather than a bare stub object: the
// ambient-cache test below hands `mockUseTelegramBindings` the REAL
// `useTelegramBindings` back, which is the only way to assert that this
// component reads the app's shared query cache instead of a private one.
vi.mock('@/lib/telegramApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/telegramApi')>()
  return {
    ...actual,
    useTelegramBindings: (machine: unknown, enabled: unknown, refetchIntervalMs: unknown) =>
      mockUseTelegramBindings(machine, enabled, refetchIntervalMs),
    useDeleteTelegramBinding: (machine: unknown) => mockUseDeleteTelegramBinding(machine),
    useTelegramConfig: (machine: unknown, enabled: unknown) => mockUseTelegramConfig(machine, enabled),
  }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

// The dialog reads the catalog to find which project this thread belongs to,
// so it can offer publishing the whole project. Defaults to "no project",
// which is what an SSH thread looks like and keeps the pre-existing
// per-session assertions below unchanged.
const mockUseWorkspaces = vi.fn((): { data: Workspace[] | undefined } => ({ data: [] }))
vi.mock('@/features/data/queries', () => ({
  useWorkspaces: () => mockUseWorkspaces(),
}))

const realTelegramApi = await vi.importActual<typeof import('@/lib/telegramApi')>('@/lib/telegramApi')
const { TelegramPublishButton } = await import('./TelegramPublishButton')

const machine: Machine = {
  id: 'm1',
  name: 'prod-runtime',
  url: 'http://runtime:9199',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

function binding(over: Partial<TelegramBinding> = {}): TelegramBinding {
  return { threadId: 'ssh:c-a1b2', chatId: -100234, topicId: 17, lastSeq: 0, ...over }
}

function config(over: Partial<TelegramConfig> = {}): TelegramConfig {
  return { enabled: true, hasToken: true, botUsername: '', ...over }
}

beforeEach(() => {
  mockUseTelegramBindings.mockReturnValue({ data: [], isLoading: false, error: null })
  mockUseDeleteTelegramBinding.mockReturnValue({ mutate: mockDeleteBindingMutate, isPending: false })
  // Default: bridge ready (token set, enabled). Every pre-existing test in
  // this file exercises the /init flow and predates CHANGE 1's gating, so
  // this default keeps them all green; individual tests below override it
  // to exercise the blocked states.
  mockUseTelegramConfig.mockReturnValue({ data: config(), isLoading: false, error: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  // Undo any per-test navigator.clipboard stub so the "unavailable" default
  // (jsdom has no Clipboard API at all) is what every other test sees.
  // @ts-expect-error test-only cleanup of a property tests may have defined
  delete navigator.clipboard
})

describe('TelegramPublishButton', () => {
  it('reads "Publish ke Telegram" and opens the dialog when there is no binding', () => {
    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)

    const trigger = screen.getByRole('button', { name: /publish ke telegram/i })
    expect(trigger).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(trigger)

    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('ignores a binding for a different thread and still offers to publish', () => {
    mockUseTelegramBindings.mockReturnValue({ data: [binding({ threadId: 'w-9f3c' })], isLoading: false, error: null })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)

    expect(screen.getByRole('button', { name: /publish ke telegram/i })).toBeTruthy()
  })

  // ---- The new flow: /init <threadId>, not a chatId/topicId form. ----

  it('shows the exact /init command for this thread, and no chat-id or topic-id input', () => {
    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2::chat-2" />)

    fireEvent.click(screen.getByRole('button', { name: /publish ke telegram/i }))

    // The whole point of the redesign: Telegram never shows chatId/topicId,
    // so the dialog must not ask for them, and thread ids (which contain `:`
    // and `::`) must render exactly, not truncated or escaped.
    expect(screen.getByText('/init ssh:c-a1b2::chat-2')).toBeTruthy()
    expect(screen.queryByLabelText(/chat id/i)).toBeNull()
    expect(screen.queryByLabelText(/topic id/i)).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })

  it('polls the binding list while open and unbound, and stops the instant a binding appears', () => {
    mockUseTelegramBindings.mockReturnValue({ data: [], isLoading: false, error: null })
    const { rerender } = render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)

    // Not open yet: nothing should be asking for an interval.
    expect(mockUseTelegramBindings).not.toHaveBeenCalledWith(machine, true, expect.any(Number))

    fireEvent.click(screen.getByRole('button', { name: /publish ke telegram/i }))

    // Open + unbound: some observer must be polling.
    expect(mockUseTelegramBindings).toHaveBeenCalledWith(machine, true, expect.any(Number))

    mockUseTelegramBindings.mockClear()
    mockUseTelegramBindings.mockReturnValue({
      data: [binding({ threadId: 'ssh:c-a1b2' })],
      isLoading: false,
      error: null,
    })
    rerender(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)

    // Bound now: the polling observer must be disabled — no more truthy
    // enabled+interval combination anywhere in this render's calls.
    for (const call of mockUseTelegramBindings.mock.calls) {
      const [, enabledArg, intervalArg] = call as [unknown, boolean, number | undefined]
      expect(enabledArg && typeof intervalArg === 'number').toBe(false)
    }
  })

  it('does not poll once the dialog is closed', () => {
    mockUseTelegramBindings.mockReturnValue({ data: [], isLoading: false, error: null })
    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)

    fireEvent.click(screen.getByRole('button', { name: /publish ke telegram/i }))
    expect(mockUseTelegramBindings).toHaveBeenCalledWith(machine, true, expect.any(Number))

    mockUseTelegramBindings.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /batal/i }))

    for (const call of mockUseTelegramBindings.mock.calls) {
      const [, enabledArg, intervalArg] = call as [unknown, boolean, number | undefined]
      expect(enabledArg && typeof intervalArg === 'number').toBe(false)
    }
  })

  it('the moment a binding exists, the dialog shows the confirmed state naming the destination', () => {
    mockUseTelegramBindings.mockReturnValue({ data: [binding({ threadId: 'ssh:c-a1b2' })], isLoading: false, error: null })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)

    const trigger = screen.getByRole('button', { name: /terpublish/i })
    expect(trigger).toBeTruthy()

    fireEvent.click(trigger)

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/-100234/)).toBeTruthy()
    expect(screen.queryByText('/init ssh:c-a1b2')).toBeNull()
  })

  it('the confirmed state offers unpublish, and calling it invokes the delete mutation', () => {
    mockUseTelegramBindings.mockReturnValue({ data: [binding({ threadId: 'ssh:c-a1b2' })], isLoading: false, error: null })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)
    fireEvent.click(screen.getByRole('button', { name: /terpublish/i }))
    fireEvent.click(screen.getByRole('button', { name: /^unpublish$/i }))

    expect(mockDeleteBindingMutate).toHaveBeenCalledWith('ssh:c-a1b2', expect.anything())
  })

  it('the confirmed state mentions that /unpublish in Telegram does the same thing', () => {
    mockUseTelegramBindings.mockReturnValue({ data: [binding({ threadId: 'ssh:c-a1b2' })], isLoading: false, error: null })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)
    fireEvent.click(screen.getByRole('button', { name: /terpublish/i }))

    expect(screen.getByText(/\/unpublish/)).toBeTruthy()
  })

  // ---- CHANGE 1: publishing must be impossible until the bridge can
  // actually work. With no token, or a token but the bridge disabled, no
  // long-poll loop is running on the target process — /init sent into that
  // void gets silence and no explanation. ----

  it('offers no /init command when the target has no bot token, and names Settings → Network → Telegram', () => {
    mockUseTelegramConfig.mockReturnValue({ data: config({ hasToken: false, enabled: false }), isLoading: false, error: null })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)
    fireEvent.click(screen.getByRole('button', { name: /telegram/i }))

    expect(screen.queryByText('/init ssh:c-a1b2')).toBeNull()
    expect(screen.getByText(/Settings → Network → Telegram/)).toBeTruthy()
  })

  it('shows the loading state, not "belum diatur", while the config is still in flight', () => {
    // `readinessOf` fails closed, so an unresolved config reads as `no-token`.
    // That is the right default but the wrong thing to PAINT: shown while the
    // request is still in flight it sends an operator whose bridge is healthy
    // off to Settings to fix a problem that does not exist. A not-yet-known
    // answer must never be rendered as a known negative one.
    mockUseTelegramConfig.mockReturnValue({ data: undefined, isLoading: true, error: null })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)

    expect(screen.getByRole('button', { name: /telegram…/i })).toBeTruthy()
    expect(screen.queryByText(/belum diatur/i)).toBeNull()
  })

  it('names the machine that actually needs the token, not "this machine"', () => {
    // An SSH thread runs on its connection's EXECUTOR runtime, which is
    // routinely a different box from the one the operator is sitting at (a
    // live install had three connections executing on "home-laptop" while the
    // token was set on the hub). "Set the token in Settings" without naming
    // the machine sends the operator to configure the wrong one and see no
    // change — a silence with a helpful-looking message on top of it.
    mockUseTelegramConfig.mockReturnValue({ data: config({ hasToken: false, enabled: false }), isLoading: false, error: null })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)
    fireEvent.click(screen.getByRole('button', { name: /telegram/i }))

    expect(screen.getByText(new RegExp(machine.name))).toBeTruthy()
  })

  it('offers no /init command when the token is set but the bridge is disabled', () => {
    mockUseTelegramConfig.mockReturnValue({ data: config({ hasToken: true, enabled: false }), isLoading: false, error: null })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)
    fireEvent.click(screen.getByRole('button', { name: /telegram/i }))

    expect(screen.queryByText('/init ssh:c-a1b2')).toBeNull()
    expect(screen.getByText(/Settings → Network → Telegram/)).toBeTruthy()
  })

  it('shows the /init command when the token is set and the bridge is enabled (guards against over-blocking)', () => {
    mockUseTelegramConfig.mockReturnValue({ data: config({ hasToken: true, enabled: true }), isLoading: false, error: null })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)
    fireEvent.click(screen.getByRole('button', { name: /publish ke telegram/i }))

    expect(screen.getByText('/init ssh:c-a1b2')).toBeTruthy()
  })

  // Publishing one session at a time goes stale by design: every session
  // created afterwards stays invisible until someone remembers to /init it
  // too. The whole-project command is offered right where the operator is
  // already deciding to publish.
  it('offers the whole-project command for a thread that belongs to a project', () => {
    mockUseWorkspaces.mockReturnValue({
      data: [
        {
          id: 'ws1',
          name: 'acme',
          projects: [
            { id: 'p-42', name: 'devdeck', worktrees: [{ id: 'w-abc' }] },
            { id: 'p-99', name: 'other', worktrees: [{ id: 'w-zzz' }] },
          ],
        },
      ] as unknown as Workspace[],
    })

    render(<TelegramPublishButton machine={machine} threadId="w-abc" />)
    fireEvent.click(screen.getByRole('button', { name: /publish ke telegram/i }))

    expect(screen.getByText('/init w-abc')).toBeTruthy()
    expect(screen.getByText('/init p-42')).toBeTruthy()
    expect(screen.getByText(/pesan\s+pertama di chat itu membuat sesi baru/i)).toBeTruthy()
  })

  // An extra chat pane is "<worktreeId>::chat-N", so the project lookup has
  // to strip the suffix or a pane would look like it belongs to nothing.
  it('finds the project of an extra chat pane', () => {
    mockUseWorkspaces.mockReturnValue({
      data: [
        { id: 'ws1', name: 'acme', projects: [{ id: 'p-42', name: 'devdeck', worktrees: [{ id: 'w-abc' }] }] },
      ] as unknown as Workspace[],
    })

    render(<TelegramPublishButton machine={machine} threadId="w-abc::chat-2" />)
    fireEvent.click(screen.getByRole('button', { name: /publish ke telegram/i }))

    expect(screen.getByText('/init p-42')).toBeTruthy()
  })

  // An SSH thread has no project, and offering a command that resolves to
  // nothing would just be a dead end.
  it('offers no project command for a thread with no project', () => {
    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)
    fireEvent.click(screen.getByRole('button', { name: /publish ke telegram/i }))

    expect(screen.getByText('/init ssh:c-a1b2')).toBeTruthy()
    expect(screen.queryByText(/seluruh project/i)).toBeNull()
  })

  it('still renders the confirmed/unpublish state for an existing binding even when hasToken is false', () => {
    mockUseTelegramConfig.mockReturnValue({ data: config({ hasToken: false, enabled: false }), isLoading: false, error: null })
    mockUseTelegramBindings.mockReturnValue({ data: [binding({ threadId: 'ssh:c-a1b2' })], isLoading: false, error: null })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)

    const trigger = screen.getByRole('button', { name: /terpublish/i })
    expect(trigger).toBeTruthy()

    fireEvent.click(trigger)

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/-100234/)).toBeTruthy()
  })

  // ---- Copy button: must degrade gracefully, never throw. ----

  it('copies the command to the clipboard when navigator.clipboard is available', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)
    fireEvent.click(screen.getByRole('button', { name: /publish ke telegram/i }))
    fireEvent.click(screen.getByRole('button', { name: /copy/i }))

    expect(writeText).toHaveBeenCalledWith('/init ssh:c-a1b2')
  })

  it('does not throw when navigator.clipboard is unavailable, and keeps the command visible', () => {
    // jsdom's default: no Clipboard API at all.
    expect(navigator.clipboard).toBeUndefined()

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)
    fireEvent.click(screen.getByRole('button', { name: /publish ke telegram/i }))

    expect(() => fireEvent.click(screen.getByRole('button', { name: /copy/i }))).not.toThrow()
    expect(screen.getByText('/init ssh:c-a1b2')).toBeTruthy()
  })

  // ---- The binding list is a data surface: loading and failure are states,
  // not silence. `binding === undefined` means BOTH "not published" and "we
  // don't know", and the operator must be able to tell those apart. ----

  it('does not offer to publish while the binding list is still loading', () => {
    mockUseTelegramBindings.mockReturnValue({ data: undefined, isLoading: true, error: null })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)

    // Claiming "Publish ke Telegram" here would be a guess: this thread may
    // already be bound, and the answer simply has not arrived yet.
    expect(screen.queryByRole('button', { name: /publish ke telegram/i })).toBeNull()
    expect(screen.getByRole('button', { name: /telegram…/i })).toBeTruthy()
  })

  it('surfaces a failed binding fetch instead of silently claiming the thread is unpublished', () => {
    const refetch = vi.fn()
    mockUseTelegramBindings.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('telegram bridge unreachable'),
      refetch,
    })

    render(<TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />)

    expect(screen.queryByRole('button', { name: /publish ke telegram/i })).toBeNull()
    const failed = screen.getByRole('button', { name: /telegram gagal/i })
    expect(failed.getAttribute('title')).toContain('telegram bridge unreachable')

    fireEvent.click(failed)
    expect(refetch).toHaveBeenCalled()
  })

  // ---- The button must ride the app's ambient QueryClient. A private,
  // per-mount client never sees the invalidations `useDeleteTelegramBinding`
  // fires, so unpublishing a thread from the settings panel would leave this
  // header still reading "Terpublish". ----

  it('reads the binding list out of the ambient query cache, not a private one', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // Exactly what a mutation elsewhere in the app leaves behind for this
    // key. `staleTime` on the real hook keeps this fresh, so nothing refetches.
    //
    // The target segment is `machine:<id>`, not a bare id: `telegramTargetKey`
    // namespaces it so a registered runtime can never collide with the `self`
    // row, which addresses the same routes on this origin and has no Machine
    // record at all on a --role hub process.
    client.setQueryData(['telegram', 'bindings', 'machine:m1'], [binding({ threadId: 'ssh:c-a1b2' })])
    mockUseTelegramBindings.mockImplementation((m: unknown, enabled: unknown, refetchIntervalMs: unknown) =>
      realTelegramApi.useTelegramBindings(m as Machine, enabled as boolean, refetchIntervalMs as number | undefined),
    )

    render(
      <QueryClientProvider client={client}>
        <TelegramPublishButton machine={machine} threadId="ssh:c-a1b2" />
      </QueryClientProvider>,
    )

    expect(screen.getByRole('button', { name: /terpublish/i })).toBeTruthy()
  })
})
