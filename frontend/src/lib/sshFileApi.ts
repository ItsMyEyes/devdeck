// Typed client for a saved SSH connection's remote file browser (backend:
// internal/service/ssh_file.go over SFTP). Unlike machineApi.ts's worktree
// file functions, these are hub-scoped (no direct-vs-proxy machine
// resolution) — Phase 1 SSH sessions always execute on the hub, same as
// sshClient.ts's shell WS URL.

import { ApiError, request } from './api'
import type { TransferProgress } from './machineClient'
import { grepParams, normalizeGrepResult, type GrepOptions, type GrepResult } from './machineApi'

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

export interface SSHFileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
}

export interface SSHFileContent {
  path: string
  content: string
}

export function fetchSSHFiles(connectionId: string, path = ''): Promise<SSHFileEntry[]> {
  return request<SSHFileEntry[]>('GET', `/ssh/connections/${connectionId}/files?path=${encodeURIComponent(path)}`)
}

export function fetchSSHFile(connectionId: string, path: string): Promise<SSHFileContent> {
  return request<SSHFileContent>('GET', `/ssh/connections/${connectionId}/file?path=${encodeURIComponent(path)}`)
}

export function writeSSHFile(connectionId: string, body: SSHFileContent): Promise<SSHFileContent> {
  return request<SSHFileContent>('PUT', `/ssh/connections/${connectionId}/file`, body)
}

export function deleteSSHFile(connectionId: string, path: string): Promise<void> {
  return request<void>('DELETE', `/ssh/connections/${connectionId}/file?path=${encodeURIComponent(path)}`)
}

export function deleteSSHPaths(connectionId: string, paths: readonly string[]): Promise<void> {
  return request<void>('POST', `/ssh/connections/${connectionId}/files/delete`, { paths })
}

export interface SearchSSHFilesOptions {
  includeDirs?: boolean
}

export function searchSSHFiles(
  connectionId: string,
  pattern: string,
  options: SearchSSHFilesOptions = {},
): Promise<string[]> {
  const params = new URLSearchParams({ pattern })
  if (options.includeDirs) params.set('includeDirs', '1')
  return request<string[]>('GET', `/ssh/connections/${connectionId}/files/search?${params}`)
}

/** Same GrepOptions/GrepResult shape as machineApi.ts's grepWorktreeFiles —
 *  see that file's comment for why the types are shared instead of
 *  re-declared here. */
export async function grepSSHFiles(
  connectionId: string,
  query: string,
  options: GrepOptions = {},
): Promise<GrepResult> {
  const result = await request<GrepResult>('GET', `/ssh/connections/${connectionId}/files/grep?${grepParams(query, options)}`)
  return normalizeGrepResult(result)
}

interface XhrOpts {
  method: 'POST'
  path: string
  body: XMLHttpRequestBodyInit
  headers?: Record<string, string>
  onUploadProgress?: (progress: TransferProgress) => void
  onDownloadProgress?: (progress: TransferProgress) => void
  responseType: 'json' | 'blob'
}

/** Same shape as machineClient.ts's machineXhr, minus machine resolution —
 *  needed here (instead of plain fetch, like the rest of this file) only
 *  for upload/download progress events. */
function apiXhr<T>(opts: XhrOpts): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(opts.method, `${API_BASE}${opts.path}`)
    xhr.responseType = opts.responseType
    for (const [key, value] of Object.entries(opts.headers ?? {})) {
      xhr.setRequestHeader(key, value)
    }
    if (opts.onUploadProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) opts.onUploadProgress?.({ loaded: event.loaded, total: event.total })
      }
    }
    if (opts.onDownloadProgress) {
      xhr.onprogress = (event) => {
        if (event.lengthComputable) opts.onDownloadProgress?.({ loaded: event.loaded, total: event.total })
      }
    }
    xhr.onerror = () => reject(new ApiError('Network request failed', 0))
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as T)
        return
      }
      if (opts.responseType === 'blob') {
        reject(new ApiError(`Request failed with status ${xhr.status}`, xhr.status))
        return
      }
      const data = xhr.response as { error?: string } | null
      const message = data && typeof data.error === 'string' ? data.error : `Request failed with status ${xhr.status}`
      reject(new ApiError(message, xhr.status))
    }
    xhr.send(opts.body)
  })
}

export function uploadSSHFileWithProgress(
  connectionId: string,
  folderPath: string,
  file: File,
  onProgress: (progress: TransferProgress) => void,
): Promise<SSHFileEntry[]> {
  const form = new FormData()
  form.append('file', file)
  return apiXhr<SSHFileEntry[]>({
    method: 'POST',
    path: `/ssh/connections/${connectionId}/files/upload?path=${encodeURIComponent(folderPath)}`,
    body: form,
    onUploadProgress: onProgress,
    responseType: 'json',
  })
}

export function downloadSSHZipWithProgress(
  connectionId: string,
  paths: readonly string[],
  onProgress: (progress: TransferProgress) => void,
): Promise<Blob> {
  return apiXhr<Blob>({
    method: 'POST',
    path: `/ssh/connections/${connectionId}/files/zip`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
    onDownloadProgress: onProgress,
    responseType: 'blob',
  })
}
