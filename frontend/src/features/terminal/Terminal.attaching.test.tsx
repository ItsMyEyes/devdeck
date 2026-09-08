// The "attaching to session…" state, and the three ways it has to end.
//
// A terminal that has not received its first byte paints an empty black
// rectangle, which is indistinguishable from a session that came up with
// nothing to say. That gap widened when tile tabs stopped mounting eagerly
// (`useMountedTabIds`): a terminal now genuinely reattaches when you open its
// tab, instead of having been kept warm since the app started.
//
// The hint covers the whole pane, so anything the terminal itself needs to
// show — replayed scrollback, the connection-error line, the reconnect line —
// must take it down first. These tests hold that.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Machine } from '@/store/types'
import { Terminal } from './Terminal'

/** Matches `ATTACH_HINT_DELAY_MS` in Terminal.tsx. */
const ATTACH_HINT_DELAY_MS = 220

vi.mock('@/lib/terminalClient', () => ({
  inputFrame: (s: string) => s,
  resizeFrame: () => '',
  terminalWsUrl: () => Promise.resolve('ws://test.invalid/ws/terminal'),
}))

/** Enough of a socket for this component: it only ever assigns the four
 *  handlers, reads `readyState`, and calls `send`/`close`. */
class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeSocket[] = []

  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  readyState = FakeSocket.OPEN
  binaryType = ''

  url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send() {}
  close() {}
}

const machine: Machine = {
  id: 'm1',
  name: 'Machine One',
  url: 'https://m1.example',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function attachingOverlay() {
  return document.querySelector('[data-terminal-attaching]')
}

/** Mounts, then lets the `terminalWsUrl` promise settle so the socket exists. */
async function mount() {
  render(<Terminal session="sess-1" machine={machine} />)
  await act(async () => {})
  return FakeSocket.instances[FakeSocket.instances.length - 1]
}

describe('terminal attach hint', () => {
  it('stays out of the way while a fast session comes up', async () => {
    await mount()
    // Just under the threshold: a local PTY usually replays inside this
    // window, and an indicator that flashed for 40ms would be noise.
    await act(async () => {
      vi.advanceTimersByTime(ATTACH_HINT_DELAY_MS - 1)
    })
    expect(attachingOverlay()).toBeNull()
  })

  it('says what it is waiting for once the wait is real', async () => {
    await mount()
    await act(async () => {
      vi.advanceTimersByTime(ATTACH_HINT_DELAY_MS)
    })
    expect(attachingOverlay()).not.toBeNull()
    expect(attachingOverlay()?.textContent).toContain('attaching to session')
  })

  it('gets out of the way as soon as the session sends anything', async () => {
    const socket = await mount()
    await act(async () => {
      vi.advanceTimersByTime(ATTACH_HINT_DELAY_MS)
    })
    expect(attachingOverlay()).not.toBeNull()

    await act(async () => {
      socket.onmessage?.({ data: 'hello from the pty\r\n' })
    })
    expect(attachingOverlay()).toBeNull()
  })

  it('gets out of the way on a connection error, so the error is readable', async () => {
    // The error line is written INTO the terminal buffer. Left up, the
    // opaque hint would hide it and an unreachable runtime would look busy
    // forever instead of broken.
    const socket = await mount()
    await act(async () => {
      vi.advanceTimersByTime(ATTACH_HINT_DELAY_MS)
    })
    expect(attachingOverlay()).not.toBeNull()

    await act(async () => {
      socket.onerror?.()
    })
    expect(attachingOverlay()).toBeNull()
  })

  it('gets out of the way when the socket closes into a reconnect', async () => {
    const socket = await mount()
    await act(async () => {
      vi.advanceTimersByTime(ATTACH_HINT_DELAY_MS)
    })
    expect(attachingOverlay()).not.toBeNull()

    await act(async () => {
      socket.onclose?.({ reason: '' })
    })
    expect(attachingOverlay()).toBeNull()
  })
})
