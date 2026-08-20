import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { Machine } from '@/store/types'
import { Terminal, type TerminalContextSelection, type TerminalHandle } from './Terminal'

/**
 * First coverage for `Terminal.tsx`. Scope: T13 of
 * docs/superpowers/plans/2026-08-15-composer-context-attachments.md —
 * `captureSelection()` and the selection-driven "Send to chat" affordance.
 * Everything else the component does (socket lifecycle, reconnect backoff,
 * search bar) is out of scope here.
 */

vi.mock('@/lib/terminalClient', () => ({
  inputFrame: (s: string) => s,
  resizeFrame: () => '',
  // Never resolves: these tests drive the captured xterm instance directly
  // and don't need a live socket to exist.
  terminalWsUrl: () => new Promise(() => {}),
}))

// Captures the real `@xterm/xterm` `Terminal` instance that `Terminal.tsx`
// constructs, so tests can drive a selection through xterm's own
// programmatic API (`selectLines`/`clearSelection`, `xterm.d.ts:1186-1198`)
// exactly the way a user's mouse drag would end up calling it internally,
// rather than re-implementing xterm's selection model in a fake. Everything
// else about xterm (rendering, addons) stays real.
const capturedTerms: XTerm[] = []
vi.mock('@xterm/xterm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xterm/xterm')>()
  class CapturingTerminal extends actual.Terminal {
    constructor(...args: ConstructorParameters<typeof actual.Terminal>) {
      super(...args)
      capturedTerms.push(this)
    }
  }
  return { ...actual, Terminal: CapturingTerminal }
})

afterEach(() => {
  cleanup()
  capturedTerms.length = 0
})

const machine: Machine = {
  id: 'm1',
  name: 'Machine One',
  url: 'https://m1.example',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

async function mountWithContent(
  text: string,
  opts: { session?: string; onSendToChat?: (selection: TerminalContextSelection) => void } = {},
) {
  const ref = createRef<TerminalHandle>()
  render(
    <Terminal
      ref={ref}
      session={opts.session ?? 'sess-1'}
      machine={machine}
      onSendToChat={opts.onSendToChat}
    />,
  )
  const term = capturedTerms[capturedTerms.length - 1]
  // `term.write` is fire-and-forget; its completion callback is the only
  // signal that the buffer actually holds the content before a test selects
  // lines out of it.
  await act(async () => {
    await new Promise<void>((resolve) => term.write(text, resolve))
  })
  return { ref, term }
}

describe('Terminal captureSelection', () => {
  it('returns null when there is no active selection', async () => {
    const { ref } = await mountWithContent('line one\r\nline two\r\n')
    expect(ref.current?.captureSelection()).toBeNull()
  })

  it('returns the selected text, this session, and a correct 1-indexed line range', async () => {
    const { ref, term } = await mountWithContent('line one\r\nline two\r\nline three\r\n')
    act(() => {
      term.selectLines(0, 1)
    })
    expect(ref.current?.captureSelection()).toEqual({
      text: 'line one\nline two',
      sessionKey: 'sess-1',
      startLine: 1,
      endLine: 2,
    })
  })

  it('carries this component instance\'s own session prop as sessionKey', async () => {
    const { ref, term } = await mountWithContent('a\r\nb\r\n', { session: 'sess-9' })
    act(() => {
      term.selectLines(0, 0)
    })
    expect(ref.current?.captureSelection()?.sessionKey).toBe('sess-9')
  })

  it('returns null again once the selection is cleared', async () => {
    const { ref, term } = await mountWithContent('line one\r\nline two\r\n')
    act(() => {
      term.selectLines(0, 1)
    })
    expect(ref.current?.captureSelection()).not.toBeNull()
    act(() => {
      term.clearSelection()
    })
    expect(ref.current?.captureSelection()).toBeNull()
  })
})

describe('Terminal "Send to chat" affordance', () => {
  it('is absent while there is no selection', async () => {
    await mountWithContent('line one\r\nline two\r\n')
    expect(screen.queryByRole('button', { name: /send to chat/i })).not.toBeInTheDocument()
  })

  it('appears once a selection is made, driven by onSelectionChange', async () => {
    const { term } = await mountWithContent('line one\r\nline two\r\n')
    expect(screen.queryByRole('button', { name: /send to chat/i })).not.toBeInTheDocument()
    act(() => {
      term.selectLines(0, 1)
    })
    expect(screen.getByRole('button', { name: /send to chat/i })).toBeInTheDocument()
  })

  it('disappears again once the selection is cleared', async () => {
    const { term } = await mountWithContent('line one\r\nline two\r\n')
    act(() => {
      term.selectLines(0, 1)
    })
    expect(screen.getByRole('button', { name: /send to chat/i })).toBeInTheDocument()
    act(() => {
      term.clearSelection()
    })
    expect(screen.queryByRole('button', { name: /send to chat/i })).not.toBeInTheDocument()
  })

  it('captures the selection and reports it through onSendToChat when clicked', async () => {
    const onSendToChat = vi.fn()
    const { term } = await mountWithContent('line one\r\nline two\r\n', { onSendToChat })
    act(() => {
      term.selectLines(0, 1)
    })
    fireEvent.click(screen.getByRole('button', { name: /send to chat/i }))
    expect(onSendToChat).toHaveBeenCalledWith({
      text: 'line one\nline two',
      sessionKey: 'sess-1',
      startLine: 1,
      endLine: 2,
    })
  })
})
