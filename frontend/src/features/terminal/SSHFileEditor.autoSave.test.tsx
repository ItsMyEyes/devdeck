import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * Auto-save at the component seam: the rules are pinned in
 * `useFileAutoSave.test.tsx`, this pins that a real file tab is wired to them —
 * that the bytes it writes are the ones on screen, that it stays quiet doing
 * it, and that `discard()` on the handle (what `cleanupFileBookkeeping` calls
 * on every close) really does stop the unmount flush.
 *
 * SSHFileEditor rather than FileEditor for the same reason
 * `SSHFileEditor.externalChange.test.tsx` picks it: the two are deliberately
 * identical here and this one has no LSP session to stand up.
 */

const writeFile = vi.fn(async (body: { path: string; content: string }) => body)
const toastSuccess = vi.fn()

let fileContent = 'v1'

vi.mock('@/features/data/queries', () => ({
  useFileTarget: () => ({
    data: { path: 'src/app.ts', content: fileContent },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useWriteFileTarget: () => ({ mutateAsync: writeFile, isPending: false }),
  useDeleteFileTarget: () => ({ mutate: vi.fn() }),
}))

vi.mock('./PlainCodeEditor', () => ({
  PlainCodeEditor: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea aria-label="buffer" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))

vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}))

const { SSHFileEditor } = await import('./SSHFileEditor')
type Handle = import('./SSHFileEditor').SSHFileEditorHandle

/** Everything below drives the flush paths, which fire immediately — no test
 *  here waits out the debounce. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
}

describe('SSHFileEditor auto-save', () => {
  beforeEach(() => {
    cleanup()
    fileContent = 'v1'
    writeFile.mockClear()
    toastSuccess.mockClear()
  })

  it('writes the edit when the app loses focus, without a toast', async () => {
    render(<SSHFileEditor connectionId="c-1" path="src/app.ts" active onDirtyChange={vi.fn()} onDeleted={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('buffer'), { target: { value: 'my edit' } })

    act(() => window.dispatchEvent(new Event('blur')))
    await settle()

    expect(writeFile).toHaveBeenCalledWith({ path: 'src/app.ts', content: 'my edit' })
    // A background write announcing itself every time is noise, not feedback —
    // Ctrl+S and the close prompt still toast.
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('writes the edit when the tab unmounts', async () => {
    const view = render(
      <SSHFileEditor connectionId="c-1" path="src/app.ts" active onDirtyChange={vi.fn()} onDeleted={vi.fn()} />,
    )
    fireEvent.change(await screen.findByLabelText('buffer'), { target: { value: 'my edit' } })

    view.unmount()
    await settle()

    expect(writeFile).toHaveBeenCalledWith({ path: 'src/app.ts', content: 'my edit' })
  })

  // The "Don't Save" path: the pane vetoes through the handle, then the tab
  // unmounts in the same commit.
  it('writes nothing once the pane discards the tab', async () => {
    const ref = createRef<Handle>()
    const view = render(
      <SSHFileEditor ref={ref} connectionId="c-1" path="src/app.ts" active onDirtyChange={vi.fn()} onDeleted={vi.fn()} />,
    )
    fireEvent.change(await screen.findByLabelText('buffer'), { target: { value: 'my edit' } })

    act(() => ref.current?.discard?.())
    view.unmount()
    await settle()

    expect(writeFile).not.toHaveBeenCalled()
  })

  it('leaves a conflicted buffer alone', async () => {
    const view = render(
      <SSHFileEditor connectionId="c-1" path="src/app.ts" active onDirtyChange={vi.fn()} onDeleted={vi.fn()} />,
    )
    fireEvent.change(await screen.findByLabelText('buffer'), { target: { value: 'my edit' } })

    // Something else writes the file while the edit is still unsaved.
    fileContent = 'written by the agent'
    view.rerender(
      <SSHFileEditor connectionId="c-1" path="src/app.ts" active onDirtyChange={vi.fn()} onDeleted={vi.fn()} />,
    )
    expect(screen.getByText(/changed on disk/i)).toBeInTheDocument()

    act(() => window.dispatchEvent(new Event('blur')))
    view.unmount()
    await settle()

    expect(writeFile).not.toHaveBeenCalled()
  })

  it('still toasts for an explicit save', async () => {
    const ref = createRef<Handle>()
    render(
      <SSHFileEditor ref={ref} connectionId="c-1" path="src/app.ts" active onDirtyChange={vi.fn()} onDeleted={vi.fn()} />,
    )
    fireEvent.change(await screen.findByLabelText('buffer'), { target: { value: 'my edit' } })

    await act(async () => {
      await ref.current?.save()
    })

    expect(toastSuccess).toHaveBeenCalledWith('Saved app.ts')
  })
})
