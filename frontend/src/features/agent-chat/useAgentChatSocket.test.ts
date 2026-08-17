/**
 * Targeted test for the one new piece of hook surface added by plan T3:
 * `clearError()`. Not a full behavioral test of the reconnect/backoff
 * machinery — that isn't touched by this change and doesn't need exercising
 * here. Only the transport-error path (`ws.onerror` firing before the
 * socket ever opens, `useAgentChatSocket.ts`'s "Could not connect…" branch)
 * is stubbed, since that's the only way `view.error` gets set without a real
 * server on the other end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { AgentChatTarget } from '@/features/agent-chat/useAgentChatSocket'
import type { Machine } from '@/store/types'

const FAKE_WS_URL = 'wss://fake.devdeck.test/ws/agent?key=test'

vi.mock('@/lib/machineClient', () => ({
  machineWsUrl: vi.fn(async () => FAKE_WS_URL),
}))

/** Minimal stand-in for the browser WebSocket. `useAgentChatSocket.ts` wires
 *  its socket via property assignment (`ws.onopen = ...`, not
 *  `addEventListener`), so that's all this needs to support. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly url: string
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly sent: string[] = []
  closed = false

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
  }
}

const { useAgentChatSocket } = await import('./useAgentChatSocket')
const { useDevDeckStore } = await import('@/store/useDevDeckStore')

const machine: Machine = { id: 'm-1', name: 'dev-machine', url: '', key: '', isLocal: false, signingPublicKey: '' }
const target: AgentChatTarget = { kind: 'machine', machine }

describe('useAgentChatSocket — clearError()', () => {
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    FakeWebSocket.instances = []
    originalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    useDevDeckStore.setState({ agentThreads: {} })
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    vi.clearAllMocks()
  })

  /** Renders the hook and waits for the stubbed `machineWsUrl` promise to
   *  resolve and the socket construction that follows it — mirrors the
   *  plan's "resolve the stubbed machineWsUrl promise" step. */
  async function renderConnecting(threadKey: string) {
    const view = renderHook(() => useAgentChatSocket({ target, threadKey }))
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    return { ...view, socket: FakeWebSocket.instances[0]! }
  }

  it('surfaces a socket that never opens as view.error (useAgentChatSocket.ts onerror branch)', async () => {
    const { result, socket } = await renderConnecting('thread-a')
    expect(result.current.view.error).toBeNull()

    act(() => {
      socket.onerror?.()
    })

    expect(result.current.view.error).toBe('Could not connect to the agent chat socket')
  })

  it('clearError() resets view.error to null and disturbs nothing else', async () => {
    const { result, socket } = await renderConnecting('thread-b')

    act(() => {
      socket.onerror?.()
    })
    expect(result.current.view.error).toBe('Could not connect to the agent chat socket')

    const socketStatusBefore = result.current.status
    const itemsBefore = result.current.view.items
    const threadStatusBefore = result.current.view.status
    const lastSeqBefore = result.current.view.lastSeq

    act(() => {
      result.current.clearError()
    })

    expect(result.current.view.error).toBeNull()
    // Nothing besides `view.error` moved: same items array reference, same
    // thread status, same lastSeq, and the socket's own connection status
    // (a distinct field from the thread status above) is untouched too —
    // this is exactly `setTransportError(null)`, nothing more.
    expect(result.current.view.items).toBe(itemsBefore)
    expect(result.current.view.status).toBe(threadStatusBefore)
    expect(result.current.view.lastSeq).toBe(lastSeqBefore)
    expect(result.current.status).toBe(socketStatusBefore)
  })

  it('clearError() is a no-op when view.error is already null', async () => {
    const { result } = await renderConnecting('thread-c')
    expect(result.current.view.error).toBeNull()
    const viewBefore = result.current.view

    expect(() => {
      act(() => {
        result.current.clearError()
      })
    }).not.toThrow()

    expect(result.current.view.error).toBeNull()
    // setTransportError(null) called while already null is an Object.is-equal
    // state update: React bails out of the re-render entirely, so the merged
    // view returned by the hook is the exact same object, not merely an
    // equal one — proof there was no extra render, not just no visible effect.
    expect(result.current.view).toBe(viewBefore)
  })
})

/** Plan T5 (`2026-08-15-composer-drafts-and-stash.md`): a draft thread — one
 *  with a `threadKey` but `connect: false` — must not open a socket, must not
 *  send a hello, and must not lose a command queued before the gate flips. */
describe('useAgentChatSocket — connect gate', () => {
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    FakeWebSocket.instances = []
    originalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    useDevDeckStore.setState({ agentThreads: {} })
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    vi.clearAllMocks()
  })

  it('connect:false never constructs a WebSocket and reports status "draft"', async () => {
    const { result } = renderHook(() => useAgentChatSocket({ target, threadKey: 'thread-draft', connect: false }))

    expect(result.current.status).toBe('draft')

    // Flush any microtasks a wrong implementation might have scheduled
    // (e.g. still calling machineWsUrl) before asserting the negative.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.status).toBe('draft')
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('the outbox trap: a turn queued while connect:false is sent exactly once, after hello, once connect flips true', async () => {
    const { result, rerender } = renderHook(
      ({ connect }: { connect: boolean }) => useAgentChatSocket({ target, threadKey: 'thread-outbox', connect }),
      { initialProps: { connect: false } },
    )

    expect(result.current.status).toBe('draft')
    expect(FakeWebSocket.instances).toHaveLength(0)

    // Queued into outboxRef — dispatch only checks socket readiness, not
    // `connect` (useAgentChatSocket.ts's dispatch callback).
    act(() => {
      result.current.sendTurn('hi')
    })

    rerender({ connect: true })

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const socket = FakeWebSocket.instances[0]!

    act(() => {
      socket.onopen?.()
    })

    type ParsedFrame = { kind: string; command?: { type: string; payload?: { text?: string } } }
    const parsed = socket.sent.map((raw) => JSON.parse(raw) as ParsedFrame)
    const helloIndex = parsed.findIndex((f) => f.kind === 'hello')
    const turnStartFrames = parsed.filter((f) => f.kind === 'command' && f.command?.type === 'thread.turn.start')
    const turnStartIndex = parsed.findIndex((f) => f.kind === 'command' && f.command?.type === 'thread.turn.start')

    // Sent exactly once — a naive "add connect to the existing effect's
    // dependency array" edit clears outboxRef on the transition and this
    // would be 0, not 1.
    expect(turnStartFrames).toHaveLength(1)
    expect(turnStartFrames[0]?.command?.payload?.text).toBe('hi')
    // After hello, not before.
    expect(helloIndex).toBeGreaterThanOrEqual(0)
    expect(turnStartIndex).toBeGreaterThan(helloIndex)
  })
})

/** Composer-context-attachments plan, T11 (C2): `sendTurn` widens by one
 *  optional argument. This is the join point between `ComposerAttachments`'
 *  `AgentAttachmentRef[]` and the actual `thread.turn.start` command — the
 *  1MB-frame / event-log-replay risk the whole subsystem's design doc names
 *  lives here (ids only, never raw bytes), so this asserts on the exact
 *  wire payload, not just that `sendTurn` was "called with something". */
describe('useAgentChatSocket — attachments', () => {
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    FakeWebSocket.instances = []
    originalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    useDevDeckStore.setState({ agentThreads: {} })
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    vi.clearAllMocks()
  })

  function parsedCommands(socket: FakeWebSocket) {
    type ParsedFrame = { kind: string; command?: { type: string; payload?: Record<string, unknown> } }
    return socket.sent
      .map((raw) => JSON.parse(raw) as ParsedFrame)
      .filter((f) => f.kind === 'command' && f.command?.type === 'thread.turn.start')
      .map((f) => f.command!.payload!)
  }

  it('includes attachments in the thread.turn.start payload when provided', async () => {
    const view = renderHook(() => useAgentChatSocket({ target, threadKey: 'thread-attach-1' }))
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const socket = FakeWebSocket.instances[0]!
    act(() => {
      socket.onopen?.()
    })

    act(() => {
      view.result.current.sendTurn('look at this', undefined, [{ id: 'att-1', kind: 'image', mime: 'image/png', name: 'shot.png' }])
    })

    const payloads = parsedCommands(socket)
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toEqual({
      text: 'look at this',
      attachments: [{ id: 'att-1', kind: 'image', mime: 'image/png', name: 'shot.png' }],
    })
  })

  it('omits the attachments key entirely when none were provided, matching the model-omission precedent', async () => {
    const view = renderHook(() => useAgentChatSocket({ target, threadKey: 'thread-attach-2' }))
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const socket = FakeWebSocket.instances[0]!
    act(() => {
      socket.onopen?.()
    })

    act(() => {
      view.result.current.sendTurn('plain text, no image')
    })

    const payloads = parsedCommands(socket)
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).not.toHaveProperty('attachments')
    expect('attachments' in payloads[0]).toBe(false)
  })

  it('omits the attachments key when an empty array is explicitly passed', async () => {
    const view = renderHook(() => useAgentChatSocket({ target, threadKey: 'thread-attach-3' }))
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const socket = FakeWebSocket.instances[0]!
    act(() => {
      socket.onopen?.()
    })

    act(() => {
      view.result.current.sendTurn('go', undefined, [])
    })

    const payloads = parsedCommands(socket)
    expect(payloads[0]).not.toHaveProperty('attachments')
  })
})
