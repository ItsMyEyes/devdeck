import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import {
  downloadWorktreeFileWithProgress,
  downloadWorktreeZipWithProgress,
  extractWorktreeArchiveWithProgress,
  uploadWorktreeFileWithProgress,
  type WorktreeFileEntry,
} from '@/lib/machineApi'
import {
  downloadSSHFileWithProgress,
  downloadSSHZipWithProgress,
  extractSSHArchiveWithProgress,
  uploadSSHFileWithProgress,
} from '@/lib/sshFileApi'
import { qk } from '@/features/data/keys'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { FilesTarget } from './filesTarget'

const UPLOAD_CONCURRENCY = 3

/** Shared by TerminalExplorer for both file sources — the upload/download
 *  calls and cache-invalidation key are the only things that differ. */
export function useFileTransfers(target: FilesTarget) {
  const queryClient = useQueryClient()
  const startTransfer = useDevDeckStore((s) => s.startTransfer)
  const updateTransferProgress = useDevDeckStore((s) => s.updateTransferProgress)
  const finishTransfer = useDevDeckStore((s) => s.finishTransfer)
  const [uploading, setUploading] = useState(false)
  /** Shared by downloadZip and downloadFile — they gate the same buttons and
   *  neither should run while the other is in flight. */
  const [downloading, setDownloading] = useState(false)

  const uploadFiles = useCallback(
    async (folderPath: string, files: readonly File[]): Promise<WorktreeFileEntry[]> => {
      const id = crypto.randomUUID()
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
      startTransfer({
        id,
        kind: 'upload',
        label: folderPath || 'root',
        totalFiles: files.length,
        completedFiles: 0,
        totalBytes,
        loadedBytes: 0,
        status: 'active',
      })
      setUploading(true)

      const fileLoaded = new Array(files.length).fill(0)
      const uploaded: WorktreeFileEntry[] = []
      let firstError: unknown = null
      let completedFiles = 0

      async function uploadOne(index: number) {
        const file = files[index]
        if (!file) return
        try {
          const onProgress = (progress: { loaded: number; total: number }) => {
            fileLoaded[index] = progress.loaded
            updateTransferProgress(id, { loadedBytes: fileLoaded.reduce((sum, n) => sum + n, 0) })
          }
          const entries =
            target.kind === 'ssh'
              ? await uploadSSHFileWithProgress(target.connectionId, folderPath, file, onProgress)
              : await uploadWorktreeFileWithProgress(target.machine, target.worktreeId, folderPath, file, onProgress)
          uploaded.push(...entries)
        } catch (error) {
          firstError = firstError ?? error
        } finally {
          completedFiles += 1
          updateTransferProgress(id, { completedFiles })
        }
      }

      const queue = files.map((_, index) => index)
      async function worker() {
        let index: number | undefined
        while ((index = queue.shift()) !== undefined) {
          await uploadOne(index)
        }
      }
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker))

      setUploading(false)
      finishTransfer(id, firstError ? 'error' : 'done', firstError instanceof Error ? firstError.message : undefined)
      const filesRootKey = target.kind === 'ssh' ? qk.sshFilesRoot(target.connectionId) : qk.worktreeFilesRoot(target.machine.id, target.worktreeId)
      await queryClient.invalidateQueries({ queryKey: filesRootKey })
      if (firstError) throw firstError
      return uploaded
    },
    [target, startTransfer, updateTransferProgress, finishTransfer, queryClient],
  )

  const downloadZip = useCallback(
    async (paths: readonly string[], label: string): Promise<Blob> => {
      const id = crypto.randomUUID()
      startTransfer({
        id,
        kind: 'download',
        label,
        totalFiles: 1,
        completedFiles: 0,
        totalBytes: 0,
        loadedBytes: 0,
        status: 'active',
      })
      setDownloading(true)
      try {
        const onProgress = (progress: { loaded: number; total: number }) =>
          updateTransferProgress(id, { loadedBytes: progress.loaded, totalBytes: progress.total })
        const blob =
          target.kind === 'ssh'
            ? await downloadSSHZipWithProgress(target.connectionId, paths, onProgress)
            : await downloadWorktreeZipWithProgress(target.machine, target.worktreeId, paths, onProgress)
        finishTransfer(id, 'done')
        return blob
      } catch (error) {
        finishTransfer(id, 'error', error instanceof Error ? error.message : undefined)
        throw error
      } finally {
        setDownloading(false)
      }
    },
    [target, startTransfer, updateTransferProgress, finishTransfer],
  )

  /** Raw bytes for one file, no zipping. Same transfer lifecycle as
   *  downloadZip so both show up in TransferStatusPanel identically. */
  const downloadFile = useCallback(
    async (path: string, label: string): Promise<Blob> => {
      const id = crypto.randomUUID()
      startTransfer({
        id,
        kind: 'download',
        label,
        totalFiles: 1,
        completedFiles: 0,
        totalBytes: 0,
        loadedBytes: 0,
        status: 'active',
      })
      setDownloading(true)
      try {
        const onProgress = (progress: { loaded: number; total: number }) =>
          updateTransferProgress(id, { loadedBytes: progress.loaded, totalBytes: progress.total })
        const blob =
          target.kind === 'ssh'
            ? await downloadSSHFileWithProgress(target.connectionId, path, onProgress)
            : await downloadWorktreeFileWithProgress(target.machine, target.worktreeId, path, onProgress)
        finishTransfer(id, 'done')
        return blob
      } catch (error) {
        finishTransfer(id, 'error', error instanceof Error ? error.message : undefined)
        throw error
      } finally {
        setDownloading(false)
      }
    },
    [target, startTransfer, updateTransferProgress, finishTransfer],
  )

  /** Uploads a zip and extracts it server-side into `folderPath` — the
   *  destination half of shellTransfer.ts's folder route (spec §6), and the
   *  only new primitive this feature needed: the existing `extract`
   *  endpoint (spec §7) has no client wrapper yet. Same transfer lifecycle
   *  and cache invalidation as uploadFiles, so a cross-shell folder drop
   *  shows up in TransferStatusPanel exactly like an ordinary upload. */
  const extractArchive = useCallback(
    async (folderPath: string, archive: Blob, label: string): Promise<WorktreeFileEntry[]> => {
      const id = crypto.randomUUID()
      startTransfer({
        id,
        kind: 'upload',
        label,
        totalFiles: 1,
        completedFiles: 0,
        totalBytes: archive.size,
        loadedBytes: 0,
        status: 'active',
      })
      setUploading(true)
      try {
        const onProgress = (progress: { loaded: number; total: number }) =>
          updateTransferProgress(id, { loadedBytes: progress.loaded, totalBytes: progress.total })
        const entries =
          target.kind === 'ssh'
            ? await extractSSHArchiveWithProgress(target.connectionId, folderPath, archive, onProgress)
            : await extractWorktreeArchiveWithProgress(target.machine, target.worktreeId, folderPath, archive, onProgress)
        finishTransfer(id, 'done')
        return entries
      } catch (error) {
        finishTransfer(id, 'error', error instanceof Error ? error.message : undefined)
        throw error
      } finally {
        setUploading(false)
        const filesRootKey = target.kind === 'ssh' ? qk.sshFilesRoot(target.connectionId) : qk.worktreeFilesRoot(target.machine.id, target.worktreeId)
        await queryClient.invalidateQueries({ queryKey: filesRootKey })
      }
    },
    [target, startTransfer, updateTransferProgress, finishTransfer, queryClient],
  )

  return { uploadFiles, downloadZip, downloadFile, extractArchive, uploading, downloading }
}
