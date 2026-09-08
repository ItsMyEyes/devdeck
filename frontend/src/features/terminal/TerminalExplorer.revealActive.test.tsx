import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SSHFileEntry } from '@/lib/sshFileApi'

/**
 * VS Code's "reveal active file in Explorer": opening a file some other way
 * (quick open, a definition jump, switching tabs) should expand every
 * ancestor folder of that file in the sidebar tree and highlight its row,
 * without the operator ever clicking through the tree themselves.
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

const ROOT: SSHFileEntry[] = [{ name: 'src', path: 'src', isDir: true, size: 0 }]
const SRC: SSHFileEntry[] = [{ name: 'index.ts', path: 'src/index.ts', isDir: false, size: 12 }]

let client: QueryClient

async function renderExplorer(activePath?: string) {
  const { TerminalExplorer } = await import('./TerminalExplorer')
  return render(
    <QueryClientProvider client={client}>
      <TerminalExplorer
        shellKey="ssh:sc-1"
        target={{ kind: 'ssh', connectionId: 'sc-1' }}
        rootLabel="Laptop Kantor"
        onOpenFile={() => {}}
        onFileDeleted={() => {}}
        activePath={activePath}
      />
    </QueryClientProvider>,
  )
}

describe('TerminalExplorer reveal active file', () => {
  beforeEach(() => {
    fetchSSHFiles.mockReset()
    fetchSSHFiles.mockImplementation(async (_connectionId, path) => (path ? SRC : ROOT))
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
  })
  afterEach(() => {
    cleanup()
    client.clear()
  })

  it('auto-expands the ancestor folder and highlights the open file', async () => {
    await renderExplorer('src/index.ts')

    const row = (await screen.findByText('index.ts')).closest('[data-row-path]')
    expect(row).not.toBeNull()
    expect(row).toHaveClass('ring-devdeck-border-accent')
  })

  it('never expands an unrelated folder when no file is open', async () => {
    await renderExplorer()
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument()
  })
})
