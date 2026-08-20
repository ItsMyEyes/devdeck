/**
 * Plan T11 (`2026-08-15-composer-drafts-and-stash.md`): `useDeleteAgentThread`
 * must clear the deleted thread's composer draft, but only once the backend
 * has actually confirmed the erase — never on a rejected request. No file in
 * this repo unit-tests `queries.ts` directly today (`SessionsPanel.test.tsx`
 * mocks `useDeleteAgentThread` away entirely), so this is the first one,
 * scoped narrowly to this one mutation.
 */
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Machine } from '@/store/types'

vi.mock('@/lib/machineClient', () => ({
  machineRequest: vi.fn(),
}))

const { machineRequest } = await import('@/lib/machineClient')
const { useDeleteAgentThread } = await import('./queries')
const { useDevDeckStore } = await import('@/store/useDevDeckStore')

const machine: Machine = {
  id: 'm-1',
  name: 'dev-machine',
  url: 'https://m1.example',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

describe('useDeleteAgentThread — draft cleanup on delete', () => {
  // `useDevDeckStore` runs its actions through the `immer` middleware, whose
  // `produce()` freezes the resulting state object in dev builds — a
  // `vi.spyOn(useDevDeckStore.getState(), 'clearComposerDraft')` throws
  // "Cannot redefine property" the moment Vitest's own `restoreAllMocks()`
  // tries to put the original back. Swapping the action via `setState` with a
  // plain object (immer's middleware only calls `produce` for the *function*
  // updater form, per `node_modules/zustand/esm/middleware/immer.mjs`) sides
  // steps that entirely and is restored by hand below.
  let originalClearComposerDraft: ReturnType<typeof useDevDeckStore.getState>['clearComposerDraft']

  beforeEach(() => {
    vi.mocked(machineRequest).mockReset()
    originalClearComposerDraft = useDevDeckStore.getState().clearComposerDraft
  })

  afterEach(() => {
    useDevDeckStore.setState({ clearComposerDraft: originalClearComposerDraft })
    vi.clearAllMocks()
  })

  it('clears the deleted thread\'s composer draft once the delete succeeds', async () => {
    vi.mocked(machineRequest).mockResolvedValue(undefined)
    const clearComposerDraftMock = vi.fn()
    useDevDeckStore.setState({ clearComposerDraft: clearComposerDraftMock })

    const { result } = renderHook(() => useDeleteAgentThread(machine, 'wt-1'), { wrapper })

    result.current.mutate('thread-abc')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(clearComposerDraftMock).toHaveBeenCalledTimes(1)
    expect(clearComposerDraftMock).toHaveBeenCalledWith('thread-abc')
  })

  it('does not clear the draft when the delete request is rejected', async () => {
    vi.mocked(machineRequest).mockRejectedValue(new Error('network down'))
    const clearComposerDraftMock = vi.fn()
    useDevDeckStore.setState({ clearComposerDraft: clearComposerDraftMock })

    const { result } = renderHook(() => useDeleteAgentThread(machine, 'wt-1'), { wrapper })

    result.current.mutate('thread-xyz')

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(clearComposerDraftMock).not.toHaveBeenCalled()
  })
})
