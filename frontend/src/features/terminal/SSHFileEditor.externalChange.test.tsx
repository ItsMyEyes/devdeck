import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * The reported bug, at the component seam: a file is open in a tab, an agent
 * rewrites it, and the tab keeps showing the old text. `fileBuffer.test.ts`
 * pins the rule; this pins that the editor is actually wired to it — including
 * the half the rule exists to protect, which is that an unsaved edit is never
 * silently thrown away to make room for the new version.
 *
 * SSHFileEditor rather than FileEditor because the two are deliberately
 * identical here (see `fileBuffer.ts`) and this one has no LSP session to
 * stand up.
 */

const writeFile = vi.fn(async (body: { path: string; content: string }) => body)
const refetch = vi.fn()

/** What the file query currently holds — the test moves this to simulate a
 *  write landing on the host underneath the open tab. */
let fileContent = 'v1'

vi.mock('@/features/data/queries', () => ({
  useFileTarget: () => ({
    data: fileContent === null ? undefined : { path: 'src/app.ts', content: fileContent },
    isLoading: false,
    error: null,
    refetch,
  }),
  useWriteFileTarget: () => ({ mutateAsync: writeFile, isPending: false }),
  useDeleteFileTarget: () => ({ mutate: vi.fn() }),
}))

vi.mock('./PlainCodeEditor', () => ({
  PlainCodeEditor: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea aria-label="buffer" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { SSHFileEditor } = await import('./SSHFileEditor')

function renderEditor() {
  const onDirtyChange = vi.fn()
  const view = render(
    <SSHFileEditor
      connectionId="c-1"
      path="src/app.ts"
      active
      onDirtyChange={onDirtyChange}
      onDeleted={vi.fn()}
    />,
  )
  return { view, onDirtyChange }
}

/** Moves the file on the host, then re-renders the tab as a poll would. */
async function serverWrites(content: string, view: { rerender: (ui: React.ReactElement) => void }) {
  fileContent = content
  view.rerender(
    <SSHFileEditor connectionId="c-1" path="src/app.ts" active onDirtyChange={vi.fn()} onDeleted={vi.fn()} />,
  )
  await waitFor(() => undefined)
}

describe('SSHFileEditor external changes', () => {
  beforeEach(() => {
    cleanup()
    fileContent = 'v1'
    writeFile.mockClear()
    refetch.mockClear()
  })

  it('shows the file it loaded', async () => {
    renderEditor()
    expect(await screen.findByLabelText('buffer')).toHaveValue('v1')
  })

  // The bug as reported: an agent edits a file that is already open.
  it('adopts a write that lands under a clean buffer', async () => {
    const { view } = renderEditor()
    await screen.findByLabelText('buffer')

    await serverWrites('written by the agent', view)

    await waitFor(() => expect(screen.getByLabelText('buffer')).toHaveValue('written by the agent'))
    expect(screen.queryByText(/changed on disk/i)).toBeNull()
  })

  // The reason the load-once latch existed. Adopting here would eat the edit.
  it('keeps unsaved edits when the file moves underneath them, and says so', async () => {
    const { view } = renderEditor()
    const buffer = await screen.findByLabelText('buffer')
    fireEvent.change(buffer, { target: { value: 'my unsaved edit' } })

    await serverWrites('written by the agent', view)

    expect(screen.getByLabelText('buffer')).toHaveValue('my unsaved edit')
    expect(screen.getByText(/changed on disk/i)).toBeInTheDocument()
  })

  it('takes the new version when the operator reloads', async () => {
    const { view } = renderEditor()
    const buffer = await screen.findByLabelText('buffer')
    fireEvent.change(buffer, { target: { value: 'my unsaved edit' } })
    await serverWrites('written by the agent', view)

    fireEvent.click(screen.getByRole('button', { name: /reload from disk/i }))

    await waitFor(() => expect(screen.getByLabelText('buffer')).toHaveValue('written by the agent'))
    expect(screen.queryByText(/changed on disk/i)).toBeNull()
  })

  // A save rebases the buffer onto what it just wrote, so the NEXT external
  // change is adopted normally rather than read as a conflict forever.
  it('resumes adopting after the operator saves over a conflict', async () => {
    const { view } = renderEditor()
    const buffer = await screen.findByLabelText('buffer')
    fireEvent.change(buffer, { target: { value: 'my unsaved edit' } })
    await serverWrites('written by the agent', view)
    expect(screen.getByText(/changed on disk/i)).toBeInTheDocument()

    // The save lands: the mutation seeds the cache with what was written.
    await serverWrites('my unsaved edit', view)
    expect(screen.queryByText(/changed on disk/i)).toBeNull()

    await serverWrites('a later agent write', view)
    await waitFor(() => expect(screen.getByLabelText('buffer')).toHaveValue('a later agent write'))
  })

  // `dirty` is derived from the buffer, so reconciling only in an effect would
  // report the adopted content as an unsaved change for one render — the tab's
  // unsaved dot blinking on and off for as long as an agent keeps writing.
  it('never reports a clean buffer as dirty across an external change', async () => {
    const onDirtyChange = vi.fn()
    const view = render(
      <SSHFileEditor connectionId="c-1" path="src/app.ts" active onDirtyChange={onDirtyChange} onDeleted={vi.fn()} />,
    )
    await screen.findByLabelText('buffer')
    onDirtyChange.mockClear()

    fileContent = 'written by the agent'
    view.rerender(
      <SSHFileEditor connectionId="c-1" path="src/app.ts" active onDirtyChange={onDirtyChange} onDeleted={vi.fn()} />,
    )
    await waitFor(() => expect(screen.getByLabelText('buffer')).toHaveValue('written by the agent'))

    expect(onDirtyChange.mock.calls.map(([, dirty]) => dirty)).not.toContain(true)
  })
})
