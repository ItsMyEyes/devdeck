import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import {
  downloadWorktreeZipWithProgress,
  uploadWorktreeFileWithProgress,
  type WorktreeFileEntry,
} from '@/lib/machineApi'
import { qk } from '@/features/data/keys'
import type { Machine } from '@/store/types'
import { useLoomStore } from '@/store/useLoomStore'

const UPLOAD_CONCURRENCY = 3

export function useFileTransfers(machine: Machine, worktreeId: string) {
  const queryClient = useQueryClient()
  const startTransfer = useLoomStore((s) => s.startTransfer)
  const updateTransferProgress = useLoomStore((s) => s.updateTransferProgress)
  const finishTransfer = useLoomStore((s) => s.finishTransfer)
  const [uploading, setUploading] = useState(false)
  const [zipping, setZipping] = useState(false)

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
          const entries = await uploadWorktreeFileWithProgress(machine, worktreeId, folderPath, file, (progress) => {
            fileLoaded[index] = progress.loaded
            updateTransferProgress(id, { loadedBytes: fileLoaded.reduce((sum, n) => sum + n, 0) })
          })
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
      await queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) })
      if (firstError) throw firstError
      return uploaded
    },
    [machine, worktreeId, startTransfer, updateTransferProgress, finishTransfer, queryClient],
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
      setZipping(true)
      try {
        const blob = await downloadWorktreeZipWithProgress(machine, worktreeId, paths, (progress) => {
          updateTransferProgress(id, { loadedBytes: progress.loaded, totalBytes: progress.total })
        })
        finishTransfer(id, 'done')
        return blob
      } catch (error) {
        finishTransfer(id, 'error', error instanceof Error ? error.message : undefined)
        throw error
      } finally {
        setZipping(false)
      }
    },
    [machine, worktreeId, startTransfer, updateTransferProgress, finishTransfer],
  )

  return { uploadFiles, downloadZip, uploading, zipping }
}
