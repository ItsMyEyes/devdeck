import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as monaco from 'monaco-editor'
import { createInlineCompletionsProvider } from './inlineCompletions'
import * as api from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api')
  return { ...actual, requestInlineCompletion: vi.fn() }
})

function makeSession(transportRequest: (method: string, params: unknown) => Promise<unknown>) {
  return { transport: { request: transportRequest } } as any
}

function makeModel(text: string, cursorOffset: number, uri?: string) {
  const model = monaco.editor.createModel(text, 'typescript', uri ? monaco.Uri.parse(uri) : undefined)
  const position = model.getPositionAt(cursorOffset)
  return { model, position }
}

const noopToken = { isCancellationRequested: false } as monaco.CancellationToken
const noopContext = {} as monaco.languages.InlineCompletionContext

describe('createInlineCompletionsProvider', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns undefined when there is no live LSP session', async () => {
    const provider = createInlineCompletionsProvider(() => null, 0)
    const { model, position } = makeModel('func foo() {}\n', 5)
    const result = await provider.provideInlineCompletions(model, position, noopContext, noopToken)
    expect(result).toBeUndefined()
    model.dispose()
  })

  it('drops a completion whose referenced call does not resolve via workspace/symbol', async () => {
    vi.mocked(api.requestInlineCompletion).mockResolvedValue({ completion: 'bogusHallucinatedFn()' })
    const transportRequest = vi.fn(async (method: string) => {
      if (method === 'workspace/symbol') return []
      return []
    })
    const provider = createInlineCompletionsProvider(() => makeSession(transportRequest), 0)
    const { model, position } = makeModel('', 0)

    const result = await provider.provideInlineCompletions(model, position, noopContext, noopToken)
    expect(result).toBeUndefined()
    model.dispose()
  })

  it('accepts a completion whose referenced call resolves via workspace/symbol', async () => {
    vi.mocked(api.requestInlineCompletion).mockResolvedValue({ completion: 'realFn()' })
    const transportRequest = vi.fn(async (method: string) => {
      if (method === 'workspace/symbol') return [{ name: 'realFn' }]
      return []
    })
    const provider = createInlineCompletionsProvider(() => makeSession(transportRequest), 0)
    const { model, position } = makeModel('', 0)

    const result = await provider.provideInlineCompletions(model, position, noopContext, noopToken)
    expect(result?.items[0]?.insertText).toBe('realFn()')
    model.dispose()
  })

  it('reuses the last suggestion locally when the user types more of it, without a new request', async () => {
    vi.mocked(api.requestInlineCompletion).mockResolvedValue({ completion: 'return 42' })
    const transportRequest = vi.fn(async () => [])
    const provider = createInlineCompletionsProvider(() => makeSession(transportRequest), 0)

    const first = makeModel('', 0)
    const firstResult = await provider.provideInlineCompletions(first.model, first.position, noopContext, noopToken)
    expect(firstResult?.items[0]?.insertText).toBe('return 42')
    first.model.dispose()
    expect(api.requestInlineCompletion).toHaveBeenCalledTimes(1)

    const second = makeModel('return 4', 8)
    const secondResult = await provider.provideInlineCompletions(second.model, second.position, noopContext, noopToken)
    expect(secondResult?.items[0]?.insertText).toBe('2')
    expect(api.requestInlineCompletion).toHaveBeenCalledTimes(1)
    second.model.dispose()
  })

  it('returns undefined when the backend returns no completion (204)', async () => {
    vi.mocked(api.requestInlineCompletion).mockResolvedValue(undefined)
    const transportRequest = vi.fn(async () => [])
    const provider = createInlineCompletionsProvider(() => makeSession(transportRequest), 0)
    const { model, position } = makeModel('', 0)

    const result = await provider.provideInlineCompletions(model, position, noopContext, noopToken)
    expect(result).toBeUndefined()
    model.dispose()
  })

  it('ignores a model other than the one it was created for (split-pane provider scoping)', async () => {
    // Simulates monaco's global per-language provider registry invoking a
    // provider created for file A's session against file B's model, which
    // happens whenever two files of the same language are open at once.
    vi.mocked(api.requestInlineCompletion).mockResolvedValue({ completion: 'shouldNotAppear' })
    const transportRequest = vi.fn(async () => [])
    const owned = makeModel('', 0, 'file:///a.ts')
    const foreign = makeModel('', 0, 'file:///b.ts')
    const provider = createInlineCompletionsProvider(
      () => makeSession(transportRequest),
      0,
      'file:///a.ts',
    )

    const result = await provider.provideInlineCompletions(foreign.model, foreign.position, noopContext, noopToken)
    expect(result).toBeUndefined()
    expect(api.requestInlineCompletion).not.toHaveBeenCalled()

    const ownResult = await provider.provideInlineCompletions(owned.model, owned.position, noopContext, noopToken)
    expect(ownResult?.items[0]?.insertText).toBe('shouldNotAppear')

    owned.model.dispose()
    foreign.model.dispose()
  })

  it('waits the real debounce window before requesting, and aborts a superseded in-flight network call', async () => {
    vi.useFakeTimers()
    try {
      const mockRequest = vi.mocked(api.requestInlineCompletion)
      const signals: Array<AbortSignal | undefined> = []
      let resolveFirst!: (value: { completion: string }) => void
      mockRequest.mockImplementationOnce((_req, opts) => {
        signals.push(opts?.signal)
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      })
      mockRequest.mockImplementationOnce((_req, opts) => {
        signals.push(opts?.signal)
        return Promise.resolve({ completion: 'second' })
      })

      const transportRequest = vi.fn(async () => [])
      // No debounceMs override here — exercises the real 300ms default the
      // other tests skip via `debounceMs=0`.
      const provider = createInlineCompletionsProvider(() => makeSession(transportRequest))

      const first = makeModel('', 0)
      const firstCall = provider.provideInlineCompletions(first.model, first.position, noopContext, noopToken)

      // Still inside the debounce window: no network call issued yet.
      await vi.advanceTimersByTimeAsync(100)
      expect(mockRequest).not.toHaveBeenCalled()

      // Let the debounce elapse and the grounding lookups resolve so the
      // first request actually reaches the network layer.
      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1))
      const firstSignal = signals[0]
      expect(firstSignal?.aborted).toBe(false)

      // A new keystroke supersedes it before the first network call resolves.
      const second = makeModel('a', 1)
      const secondCall = provider.provideInlineCompletions(second.model, second.position, noopContext, noopToken)

      expect(firstSignal?.aborted).toBe(true)

      resolveFirst({ completion: 'stale' })
      const firstResult = await firstCall
      expect(firstResult).toBeUndefined()

      await vi.advanceTimersByTimeAsync(300)
      await vi.waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2))
      const secondResult = await secondCall
      expect(secondResult?.items[0]?.insertText).toBe('second')

      first.model.dispose()
      second.model.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
