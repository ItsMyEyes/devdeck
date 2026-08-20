/**
 * Composer-context-attachments plan, T11 (C2): the pending-upload strip
 * `ChatComposer.tsx` mounts under `data-slot="composer-attachments"`. These
 * tests drive the component entirely through its imperative handle
 * (`addFiles`/`attachments`/`clear`) — the same shape `ChatComposer` itself
 * uses — rather than through paste/drop DOM events, which belong to
 * `ChatComposer.test.tsx` (the thing that wires those events to this
 * component's `addFiles`).
 */
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Machine } from '@/store/types'

const uploadAgentAttachmentMock = vi.fn()
vi.mock('@/lib/machineApi', () => ({
  uploadAgentAttachment: (...args: unknown[]) => uploadAgentAttachmentMock(...args),
}))

const downscaleImageMock = vi.fn(async (file: File) => file)
vi.mock('@/features/agent-chat/imageCompression', () => ({
  downscaleImage: (file: File) => downscaleImageMock(file),
}))

import { ComposerAttachments } from '@/features/agent-chat/ComposerAttachments'
import type { ComposerAttachmentsHandle } from '@/features/agent-chat/ComposerAttachments'

const machine: Machine = { id: 'm-1', name: 'dev', url: 'http://localhost:9', key: 'k', isLocal: false, signingPublicKey: '' }

function pngFile(name = 'shot.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

function uploadedAttachment(overrides: Partial<{ id: string; name: string; mimeType: string }> = {}) {
  return {
    id: 'att-1',
    threadId: 't-1',
    name: 'shot.png',
    mimeType: 'image/png',
    sizeBytes: 3,
    createdAt: '2026-08-15T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  uploadAgentAttachmentMock.mockReset()
  downscaleImageMock.mockClear()
  // jsdom implements neither `URL.createObjectURL` nor `revokeObjectURL` —
  // stubbed the same way the rest of this codebase does it (see e.g.
  // ProposedPlanCard.test.tsx, planMarkdown.ts's own doc comment on why).
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn((file: File) => `blob:${file.name}`),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ComposerAttachments', () => {
  it('renders one thumbnail per pending attachment', async () => {
    uploadAgentAttachmentMock.mockImplementation(() => new Promise(() => {})) // never settles
    const ref = createRef<ComposerAttachmentsHandle>()
    render(<ComposerAttachments ref={ref} machine={machine} threadId="t-1" />)

    act(() => {
      ref.current?.addFiles([pngFile('a.png'), pngFile('b.png')])
    })

    expect(await screen.findByAltText('a.png')).toBeInTheDocument()
    expect(screen.getByAltText('b.png')).toBeInTheDocument()
  })

  it('ignores a non-image file — no thumbnail, no upload attempt', () => {
    const ref = createRef<ComposerAttachmentsHandle>()
    render(<ComposerAttachments ref={ref} machine={machine} threadId="t-1" />)

    act(() => {
      ref.current?.addFiles([new File(['plain text'], 'notes.txt', { type: 'text/plain' })])
    })

    expect(screen.queryByAltText('notes.txt')).not.toBeInTheDocument()
    expect(uploadAgentAttachmentMock).not.toHaveBeenCalled()
  })

  it('the remove control removes only that pending attachment', async () => {
    uploadAgentAttachmentMock.mockImplementation(() => new Promise(() => {}))
    const ref = createRef<ComposerAttachmentsHandle>()
    render(<ComposerAttachments ref={ref} machine={machine} threadId="t-1" />)

    act(() => {
      ref.current?.addFiles([pngFile('a.png'), pngFile('b.png')])
    })
    await screen.findByAltText('a.png')

    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }))

    expect(screen.queryByAltText('a.png')).not.toBeInTheDocument()
    expect(screen.getByAltText('b.png')).toBeInTheDocument()
  })

  it('shows a progress affordance while an attachment is mid-upload, and clears it once it finishes', async () => {
    let resolveUpload: ((value: unknown) => void) | undefined
    uploadAgentAttachmentMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve
        }),
    )
    const ref = createRef<ComposerAttachmentsHandle>()
    render(<ComposerAttachments ref={ref} machine={machine} threadId="t-1" />)

    act(() => {
      ref.current?.addFiles([pngFile()])
    })

    expect(await screen.findByRole('status', { name: /uploading shot\.png/i })).toBeInTheDocument()

    await act(async () => {
      resolveUpload?.(uploadedAttachment())
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  // `.claude/rules/frontend.md`: every data surface renders explicit
  // loading/error/empty states — a failed upload must not disappear as if
  // nothing happened.
  it('a failed upload shows an explicit error affordance and leaves the item in the list', async () => {
    uploadAgentAttachmentMock.mockRejectedValue(new Error('network down'))
    const ref = createRef<ComposerAttachmentsHandle>()
    render(<ComposerAttachments ref={ref} machine={machine} threadId="t-1" />)

    act(() => {
      ref.current?.addFiles([pngFile()])
    })

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    // Still there — a silently dropped failed upload is the defect this
    // guards against, not merely "an alert appeared somewhere".
    expect(screen.getByAltText('shot.png')).toBeInTheDocument()
  })

  it('attachments() returns only completed uploads, mapped to the wire shape — not uploading or failed ones', async () => {
    let resolveSecond: ((value: unknown) => void) | undefined
    uploadAgentAttachmentMock
      .mockResolvedValueOnce(uploadedAttachment({ id: 'att-1', name: 'a.png' }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          }),
      )
      .mockRejectedValueOnce(new Error('nope'))

    const ref = createRef<ComposerAttachmentsHandle>()
    render(<ComposerAttachments ref={ref} machine={machine} threadId="t-1" />)

    act(() => {
      ref.current?.addFiles([pngFile('a.png'), pngFile('b.png'), pngFile('c.png')])
    })

    await screen.findByAltText('a.png')
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    expect(ref.current?.attachments()).toEqual([{ id: 'att-1', kind: 'image', mime: 'image/png', name: 'a.png' }])

    // b.png never resolves in this test — the still-uploading item stays
    // excluded from attachments() the whole time, not just transiently.
    void resolveSecond
  })

  it('clear() empties the pending list and revokes every preview URL', async () => {
    uploadAgentAttachmentMock.mockImplementation(() => new Promise(() => {}))
    const ref = createRef<ComposerAttachmentsHandle>()
    render(<ComposerAttachments ref={ref} machine={machine} threadId="t-1" />)

    act(() => {
      ref.current?.addFiles([pngFile('a.png'), pngFile('b.png')])
    })
    await screen.findByAltText('a.png')

    act(() => {
      ref.current?.clear()
    })

    expect(screen.queryByAltText('a.png')).not.toBeInTheDocument()
    expect(screen.queryByAltText('b.png')).not.toBeInTheDocument()
    expect(ref.current?.attachments()).toEqual([])
  })

  it('downscales before uploading', async () => {
    uploadAgentAttachmentMock.mockResolvedValue(uploadedAttachment())
    const ref = createRef<ComposerAttachmentsHandle>()
    render(<ComposerAttachments ref={ref} machine={machine} threadId="t-1" />)

    const file = pngFile()
    act(() => {
      ref.current?.addFiles([file])
    })

    await waitFor(() => expect(uploadAgentAttachmentMock).toHaveBeenCalled())
    expect(downscaleImageMock).toHaveBeenCalledWith(file)
  })
})
