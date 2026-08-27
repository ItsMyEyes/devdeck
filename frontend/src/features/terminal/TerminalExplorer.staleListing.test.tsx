import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { SSHFileEntry } from '@/lib/sshFileApi'

/**
 * A remote file tree must not be thrown away because ONE refetch failed.
 *
 * The reported symptom: a flaky link drops the SFTP connection, the listing
 * request fails, and the entire explorer collapses to `read folder "" failed`
 * with a Retry button — while the terminal beside it, which holds a different
 * SSH connection, is still perfectly alive. Every folder the operator had
 * expanded is gone, and pressing Retry on a bad link just reproduces it.
 *
 * React Query keeps the last successful `data` alongside the new `error`, so
 * there was always a listing to keep showing; `TreeLevel` simply checked
 * `error` before it looked at whether it had anything. This pins the order.
 */

const fetchSSHFiles = vi.fn<(connectionId: string, path?: string) => Promise<SSHFileEntry[]>>()

vi.mock('@/lib/sshFileApi', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sshFileApi')>('@/lib/sshFileApi')
  return { ...actual, fetchSSHFiles: (connectionId: string, path?: string) => fetchSSHFiles(connectionId, path) }
})

// jsdom has no layout; the explorer's drag/scroll plumbing reads these.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const ENTRIES: SSHFileEntry[] = [
  { name: 'Documents', path: 'Documents', isDir: true, size: 0 },
  { name: 'notes.txt', path: 'notes.txt', isDir: false, size: 12 },
]

let client: QueryClient

async function renderExplorer() {
  const { TerminalExplorer } = await import('./TerminalExplorer')
  return render(
    <QueryClientProvider client={client}>
      <TerminalExplorer
        shellKey="ssh:sc-1"
        target={{ kind: 'ssh', connectionId: 'sc-1' }}
        rootLabel="Laptop Kantor"
        onOpenFile={() => {}}
        onFileDeleted={() => {}}
      />
    </QueryClientProvider>,
  )
}

describe('TerminalExplorer stale listings', () => {
  beforeEach(() => {
    fetchSSHFiles.mockReset()
    // No retries: the point of the test is what ONE failure does to the tree.
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
  })
  afterEach(() => {
    cleanup()
    client.clear()
  })

  it('keeps the listing on screen when a refetch fails', async () => {
    fetchSSHFiles.mockResolvedValueOnce(ENTRIES)
    await renderExplorer()
    expect(await screen.findByText('notes.txt')).toBeInTheDocument()

    fetchSSHFiles.mockRejectedValue(new ApiError('read folder failed', 500))
    await act(async () => {
      await client.refetchQueries()
    })

    // Synchronise on the FAILURE being on screen, not on refetchQueries
    // resolving: React Query notifies its observers through a scheduler, so
    // the re-render lands after that promise and asserting straight away
    // reads a DOM that has not seen the error yet — which passes against any
    // implementation, broken ones included.
    expect(await screen.findByText(/read folder failed/)).toBeInTheDocument()

    // The whole point: the folders the operator had are still there, beside
    // the failure rather than replaced by it.
    expect(screen.getByText('notes.txt')).toBeInTheDocument()
    expect(screen.getByText('Documents')).toBeInTheDocument()
  })

  it('still shows the error state when the FIRST load fails', async () => {
    fetchSSHFiles.mockRejectedValue(new ApiError('read folder failed', 500))
    await renderExplorer()

    // Nothing was ever loaded, so there is nothing to preserve — the operator
    // needs the message and a way to try again.
    expect(await screen.findByText('read folder failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
