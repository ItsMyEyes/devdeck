import type { Terminal as XTerm } from '@xterm/xterm'

/**
 * Ceiling on output that has been received but not yet parsed by xterm.
 *
 * `term.write()` is fire-and-forget: xterm appends to an internal buffer and
 * drains it on a timer with a per-slice time budget, so output arriving faster
 * than the parser and renderer can consume it grows that buffer without limit.
 * Nothing in the WebSocket API lets us push back on the sender, so the only
 * way to bound the memory is to bound what we are willing to hold.
 *
 * Sized well above the server's 1 MiB reattach replay (see
 * `ringBufferMaxBytes` in backend/internal/terminal/registry.go), so this only
 * trips on genuine pathology — a runaway process, or a link so degraded that
 * replays are stacking up — never on ordinary use.
 */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024

const RESYNC_NOTICE = '\r\n\x1b[38;5;222m■ [output outran the terminal - screen resynced]\x1b[0m\r\n'

export interface TerminalWriter {
  /** Queue output for the terminal, applying backpressure and the memory cap. */
  write: (data: string | Uint8Array) => void
  /** Stop draining and release the queue. Safe to call more than once. */
  dispose: () => void
}

/**
 * Wraps an xterm instance with flow control: at most one `write` is in flight
 * at a time (using xterm's completion callback), and the backlog behind it is
 * capped.
 *
 * On overflow the backlog is dropped and the screen is reset rather than
 * spliced — cutting a byte stream at an arbitrary offset lands mid-ANSI-escape
 * and leaves the terminal rendering garbage, whereas a reset is coherent and
 * the next redraw restores a usable screen.
 */
export function createTerminalWriter(term: XTerm): TerminalWriter {
  const queue: Array<string | Uint8Array> = []
  let queuedBytes = 0
  let draining = false
  let resetPending = false
  let disposed = false

  const pump = () => {
    if (disposed) return
    const next = queue.shift()
    if (next === undefined) {
      draining = false
      return
    }
    queuedBytes -= next.length
    draining = true
    if (resetPending) {
      resetPending = false
      term.reset()
    }
    term.write(next, pump)
  }

  return {
    write(data: string | Uint8Array) {
      if (disposed || data.length === 0) return
      queue.push(data)
      queuedBytes += data.length

      if (queuedBytes > MAX_QUEUED_BYTES) {
        // The backlog is already far past anything the user could read. Keep
        // the newest chunk (the live tail is what matters), drop the rest,
        // and resync the screen when the in-flight write completes.
        queue.length = 0
        queue.push(RESYNC_NOTICE, data)
        queuedBytes = RESYNC_NOTICE.length + data.length
        resetPending = true
      }

      if (!draining) pump()
    },
    dispose() {
      disposed = true
      queue.length = 0
      queuedBytes = 0
      draining = false
      resetPending = false
    },
  }
}
