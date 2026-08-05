import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import type { FilesTarget } from './filesTarget'
import {
  encodeShellDragPayload,
  getShellTransferHandle,
  parseShellDragPayload,
  registerShellTransferHandle,
  resolveDropRoute,
  transferAcrossShells,
  unregisterShellTransferHandle,
  type ShellTransferHandle,
} from './shellTransfer'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const sourceTarget: FilesTarget = { kind: 'ssh', connectionId: 'conn-source' }
const destTarget: FilesTarget = { kind: 'ssh', connectionId: 'conn-dest' }

/** Builds a stub handle — the "transfer primitives" the spec's testing
 *  table asks these tests to stub, standing in for what a shellTransfer
 *  caller would normally read off useFileTransfers(target). */
function makeHandle(target: FilesTarget, overrides: Partial<ShellTransferHandle> = {}): ShellTransferHandle {
  return {
    target,
    downloadFile: vi.fn(async (path: string) => new Blob([path])),
    downloadZip: vi.fn(async () => new Blob(['zip'])),
    uploadFiles: vi.fn(async () => []),
    extractArchive: vi.fn(async () => []),
    invalidate: vi.fn(async () => undefined),
    ...overrides,
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('transferAcrossShells routing', () => {
  it('routes a files-only selection through per-file download → upload', async () => {
    const source = makeHandle(sourceTarget)
    const dest = makeHandle(destTarget)

    await transferAcrossShells(source, dest, ['a.txt', 'dir/b.txt'], false, 'inbox')

    expect(source.downloadFile).toHaveBeenCalledTimes(2)
    expect(source.downloadFile).toHaveBeenCalledWith('a.txt', 'a.txt')
    expect(source.downloadFile).toHaveBeenCalledWith('dir/b.txt', 'b.txt')
    expect(dest.uploadFiles).toHaveBeenCalledTimes(2)
    const [folder, files] = (dest.uploadFiles as ReturnType<typeof vi.fn>).mock.calls[0] as [string, File[]]
    expect(folder).toBe('inbox')
    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe('a.txt')
    expect(source.downloadZip).not.toHaveBeenCalled()
    expect(dest.extractArchive).not.toHaveBeenCalled()
  })

  it('routes a selection containing a folder through zip on the source → extract on the destination', async () => {
    const source = makeHandle(sourceTarget)
    const dest = makeHandle(destTarget)

    await transferAcrossShells(source, dest, ['dir', 'a.txt'], true, 'inbox')

    expect(source.downloadZip).toHaveBeenCalledTimes(1)
    expect(source.downloadZip).toHaveBeenCalledWith(['dir', 'a.txt'], expect.any(String))
    expect(dest.extractArchive).toHaveBeenCalledTimes(1)
    const [folder] = (dest.extractArchive as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Blob, string]
    expect(folder).toBe('inbox')
    expect(source.downloadFile).not.toHaveBeenCalled()
    expect(dest.uploadFiles).not.toHaveBeenCalled()
  })
})

describe('transferAcrossShells settle behaviour', () => {
  it('invalidates both sides and reports the failed count on a partial failure', async () => {
    const source = makeHandle(sourceTarget, {
      downloadFile: vi.fn(async (path: string) => {
        if (path === 'bad.txt') throw new Error('boom')
        return new Blob([path])
      }),
    })
    const dest = makeHandle(destTarget)

    await transferAcrossShells(source, dest, ['ok1.txt', 'bad.txt', 'ok2.txt'], false, 'inbox')

    expect(dest.uploadFiles).toHaveBeenCalledTimes(2)
    expect(source.invalidate).toHaveBeenCalledTimes(1)
    expect(dest.invalidate).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('1'))
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('2'))
  })

  it('invalidates both sides even when every file transfer fails', async () => {
    const source = makeHandle(sourceTarget, {
      downloadFile: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    const dest = makeHandle(destTarget)

    await transferAcrossShells(source, dest, ['a.txt'], false, 'inbox')

    expect(source.invalidate).toHaveBeenCalledTimes(1)
    expect(dest.invalidate).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('1'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('invalidates both sides when the zip/extract route itself rejects, surfacing the server message', async () => {
    const source = makeHandle(sourceTarget, {
      downloadZip: vi.fn(async () => {
        throw new ApiError('zip-slip: entry escapes destination', 400)
      }),
    })
    const dest = makeHandle(destTarget)

    await transferAcrossShells(source, dest, ['dir'], true, 'inbox')

    expect(dest.extractArchive).not.toHaveBeenCalled()
    expect(source.invalidate).toHaveBeenCalledTimes(1)
    expect(dest.invalidate).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('zip-slip: entry escapes destination')
  })

  it('falls back to a generic message when the zip/extract failure carries no server message', async () => {
    const source = makeHandle(sourceTarget, {
      downloadZip: vi.fn(async () => {
        throw new Error('network exploded')
      }),
    })
    const dest = makeHandle(destTarget)

    await transferAcrossShells(source, dest, ['dir'], true, 'inbox')

    expect(source.invalidate).toHaveBeenCalledTimes(1)
    expect(dest.invalidate).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('Could not transfer selection')
  })
})

describe('shell drag payload encode/parse', () => {
  it('round-trips a well-formed payload', () => {
    const payload = { shellKey: 'wt:worktree-1', paths: ['a.txt', 'dir/b.txt'], hasDir: false }
    expect(parseShellDragPayload(encodeShellDragPayload(payload))).toEqual(payload)
  })

  it('ignores malformed or unparseable payloads instead of throwing', () => {
    expect(parseShellDragPayload('')).toBeNull()
    expect(parseShellDragPayload('not json')).toBeNull()
    expect(parseShellDragPayload('{"shellKey":"wt:1"}')).toBeNull()
    expect(parseShellDragPayload('{"shellKey":"wt:1","paths":[1,2],"hasDir":false}')).toBeNull()
    expect(parseShellDragPayload('["just","an","array"]')).toBeNull()
  })
})

describe('resolveDropRoute', () => {
  it('routes a same-shellKey payload to move', () => {
    expect(resolveDropRoute({ shellKey: 'wt:worktree-1' }, 'wt:worktree-1')).toBe('move')
  })

  it('routes a differing-shellKey payload to transfer', () => {
    expect(resolveDropRoute({ shellKey: 'ssh:conn-source' }, 'wt:worktree-1')).toBe('transfer')
  })
})

describe('shell transfer handle registry', () => {
  it('registers, retrieves, and unregisters a handle by shellKey', () => {
    const handle = makeHandle(sourceTarget)
    registerShellTransferHandle('wt:worktree-1', handle)
    expect(getShellTransferHandle('wt:worktree-1')).toBe(handle)

    unregisterShellTransferHandle('wt:worktree-1', handle)
    expect(getShellTransferHandle('wt:worktree-1')).toBeUndefined()
  })

  // Spec non-goals require "both surfaces coexist": ShellSidebar's own
  // TerminalExplorer and the in-pane 'explorer' pane-tab TerminalExplorer
  // both mount under the identical shellKey. Their registration effects race
  // in mount/unmount order, so the registry has to survive a second mount
  // overwriting the map entry and then unmounting first.
  it('keeps the still-mounted handle resolvable when a second registration under the same shellKey unmounts first', () => {
    const sidebarHandle = makeHandle(sourceTarget)
    const paneTabHandle = makeHandle(sourceTarget)
    registerShellTransferHandle('wt:worktree-1', sidebarHandle)
    registerShellTransferHandle('wt:worktree-1', paneTabHandle)

    // The in-pane explorer tab (registered second) closes while the sidebar
    // (registered first) is still mounted — its cleanup must not evict the
    // sidebar's still-live handle.
    unregisterShellTransferHandle('wt:worktree-1', paneTabHandle)

    expect(getShellTransferHandle('wt:worktree-1')).toBe(sidebarHandle)

    unregisterShellTransferHandle('wt:worktree-1', sidebarHandle)
    expect(getShellTransferHandle('wt:worktree-1')).toBeUndefined()
  })
})
