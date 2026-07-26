# File Explorer Download — Design

**Date:** 2026-07-27
**Status:** Approved, ready for implementation planning

## Problem

The file explorer (`TerminalExplorer.tsx`) can already zip-and-download a
multi-select via the toolbar's Archive button, but three gaps remain:

1. **No per-row download.** Every row has a Delete button; getting a single
   file or folder out requires checkbox-selecting it, then finding the
   separate toolbar button.
2. **No rename step.** The zip is auto-named by `archiveFileName()`
   (`TerminalExplorer.tsx:49`) and downloads immediately — the user never
   gets to choose the archive name.
3. **No raw single-file download.** The `Read` endpoint returns JSON and
   rejects binary/non-UTF-8 files (`worktree_file.go:159-161`,
   `ssh_file.go:379-381`), so today the *only* way to get bytes out of the
   browser — even for one small file — is to zip it.

## Goals

- A Download button on every explorer row, beside the existing Delete button.
- Files download as raw bytes; folders zip automatically, then download.
- Folder/multi-select downloads let the user confirm or change the archive
  name before the zip job starts.
- Works identically for local worktrees and remote SSH connections.

## Non-goals

- Changing `FolderBrowser.tsx` (a folder *picker* for clone destinations —
  unrelated to this explorer stack).
- Resumable or chunked downloads. Existing zip download is a single
  XHR-to-blob; raw file download follows the same shape.
- A raw-bytes *directory* endpoint. Directories always go through `/files/zip`.

## Constraints discovered in the codebase

These shaped the design and must not be violated:

- **Worktree requests are machine-scoped and may need an auth header.**
  `machineXhr` (`machineClient.ts:142`) resolves direct-vs-proxy per machine;
  in direct mode it sets `Authorization: Bearer <machine.key>`
  (`machineClient.ts:71`). A plain `<a download href="...">` link **cannot**
  set that header, so raw download must go through XHR-to-blob +
  `downloadBlob()`, exactly as zip download does today. SSH downloads are
  hub-scoped (`apiXhr`, `sshFileApi.ts:91`) and need no header, but share the
  same code path for consistency.
- `XhrRequestOpts` (`machineClient.ts:126`) already permits `method: 'GET'`
  and `responseType: 'blob'`, and `body` is optional — so no client-plumbing
  changes are needed, only new call sites. `sshFileApi.ts`'s local `XhrOpts`
  (line 78) is narrower: `method: 'POST'` and `body` required. It must be
  widened to `'GET' | 'POST'` with an optional `body`.
- Path validation differs by backend and must be reused, not re-implemented:
  worktree goes through `svc.resolve(...)` (`worktree_file.go:1043`), which
  layers `normalizeRelativePath` (`:1117`) + `ensureInside` (`:1151`) and
  resolves symlinks to reject escapes; SSH goes through
  `normalizeRelativePath` + `remoteAbsPath` inside a
  `sshmgr.WithSFTPClient` callback, as `SSHFileService.Read`
  (`ssh_file.go:346`) does.
- Handlers use `handleStoreErr(w, err)` and the `{"error": "..."}` envelope
  (per `CONTRACTS.md`); services signal bad input with `ErrValidation`.

## Design

### Backend — new raw-download endpoint

Two new service methods, mirroring the existing `Read`/`Archive` split:

**`WorktreeFileService.Download(worktreeID, relativePath string) (*os.File, os.FileInfo, string, error)`**
(`service/worktree_file.go`)

- Calls `svc.resolve(worktreeID, relativePath, false, false)` — same
  validation as `Read`, including symlink-escape rejection.
- `os.Stat`; if `info.IsDir()`, return `ErrValidation` ("%q is a folder — use
  zip to download folders"). Directories are the zip endpoint's job.
- **No size cap and no UTF-8 check** — the deliberate difference from `Read`.
  `maxEditableFileSize` and the binary rejection exist to protect the *editor*;
  a download has neither constraint. This is what makes binary/large files
  downloadable for the first time.
- Opens the file and returns the handle plus its `FileInfo` and clean path.
  Caller closes.

**`SSHFileService.Download(ctx, connectionID, relativePath string, dst io.Writer) (SSHDownloadMeta, error)`**
(`service/ssh_file.go`)

`sshmgr.WithSFTPClient` scopes the `*sftp.Client` to its callback, so the
service cannot return a live remote handle. It therefore takes a destination
`io.Writer` and streams into it inside the callback — the same shape as
`Archive` (`ssh_file.go:523`), which also writes to a caller-provided `dst`.
Validation matches `SSHFileService.Read` (`ssh_file.go:346`):
`normalizeRelativePath` → `remoteAbsPath` → `client.Stat`, rejecting
directories, but **without** `Read`'s size cap and UTF-8 check.

`SSHDownloadMeta` carries `{Path string; Size int64; ModTime time.Time}` for
the handler's response headers.

The SSH handler mirrors the SSH `Archive` handler (`ssh_file.go:158`): it
streams into an `os.CreateTemp` file, then serves that via `http.ServeContent`
so range requests work, removing the temp file on return.

**Handlers** — `WorktreeFileHandler.Download` (`handler/worktree_file.go`),
`SSHFileHandler.Download` (`handler/ssh_file.go`):

```go
func (h *WorktreeFileHandler) Download(w http.ResponseWriter, r *http.Request) {
	file, info, clean, err := h.svc.Download(r.PathValue("id"), r.URL.Query().Get("path"))
	if handleStoreErr(w, err) {
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", contentDisposition(path.Base(clean)))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, path.Base(clean), info.ModTime(), file)
}
```

`Content-Type` is set explicitly to `application/octet-stream` **before**
`http.ServeContent`, which suppresses its content sniffing. This matters:
the endpoint serves user-controlled repo content, and a sniffed `text/html`
would be same-origin in proxy mode (`/api/machines/{id}/proxy/...`) and thus
an XSS vector. `Content-Disposition: attachment` is a second layer, not the
only one.

Note the frontend never relies on these headers — it reads the response as a
blob and names the saved file itself via `downloadBlob`. They exist so the
endpoint is safe and correct when hit directly.

**`contentDisposition(name string) string`** — new shared helper in
`handler/`. The existing zip handlers hardcode `filename="selection.zip"`, so
no escaping was ever needed; a real filename can contain `"`, `\`, newlines,
or non-ASCII. It emits both a sanitized ASCII `filename=` and an
RFC 5987 `filename*=UTF-8''<pct-encoded>` parameter. Used by both new
Download handlers.

**Routes** (`cmd/server/main.go`, beside the existing file routes at 411-417
and 550-556):

```go
mux.HandleFunc("GET /api/worktrees/{id}/files/download", fileH.Download)
mux.HandleFunc("GET /api/ssh/connections/{id}/files/download", sshFileH.Download)
```

The `/files/zip` handlers and `Archive` services are **unchanged**. The
archive name is a client-side concern: the frontend already discards the
server's `selection.zip` and names the saved file itself via
`downloadBlob(blob, filename)` (`TerminalExplorer.tsx:237`).

### Frontend — API layer

`machineApi.ts` — new sibling to `downloadWorktreeZipWithProgress` (line 128):

```ts
export function downloadWorktreeFileWithProgress(
  machine: Machine,
  worktreeId: string,
  filePath: string,
  onProgress: (progress: TransferProgress) => void,
): Promise<Blob> {
  return machineXhr<Blob>(machine, {
    method: 'GET',
    path: `/worktrees/${worktreeId}/files/download?path=${encodeURIComponent(filePath)}`,
    onDownloadProgress: onProgress,
    responseType: 'blob',
  })
}
```

`sshFileApi.ts` — the same for `/ssh/connections/${id}/files/download`, which
requires widening the local `XhrOpts` (line 78) to `method: 'GET' | 'POST'`
and `body?: XMLHttpRequestBodyInit`, plus `xhr.send(opts.body ?? null)`.

### Frontend — `useFileTransfers`

Add `downloadFile(path, label)` beside the existing `downloadZip` (line 86),
sharing the identical transfer-progress lifecycle (`startTransfer` →
`updateTransferProgress` → `finishTransfer`) so raw downloads appear in
`TransferStatusPanel` exactly like zips do. It dispatches on `target.kind`
and reuses the existing `zipping` flag under a renamed, shared
`downloading` state (both operations disable the same buttons and neither
should run concurrently with the other).

Returned shape becomes `{ uploadFiles, downloadZip, downloadFile, uploading, downloading }`.
The existing `zipping` consumer at `TerminalExplorer.tsx:87`/`233`/`281`/`285`
is updated to `downloading`; no other file consumes this hook.

### Frontend — `ArchiveNameDialog`

New `frontend/src/features/terminal/ArchiveNameDialog.tsx`, modeled on
`DeleteFilesDialog.tsx` (same `Dialog`/`DialogTitle`/`DialogDescription` +
`Button` composition, `width={400}`, `z={70}`):

```ts
export interface ArchiveNameDialogProps {
  open: boolean
  defaultName: string
  itemCount: number
  pending: boolean
  onCancel: () => void
  onConfirm: (filename: string) => void
}
```

- Controlled `<Input>` seeded from `defaultName` whenever the dialog opens.
- Submitting on Enter and on the Download button; Cancel and Escape close it.
- Confirm is disabled while the name is empty/whitespace or `pending` is true
  (mirrors `DeleteFilesDialog`'s pending-gating).
- On confirm, the name is normalized: trimmed, path separators stripped, and
  `.zip` appended if absent. Normalization lives in a pure exported helper
  (`normalizeArchiveName`) so it is unit-testable without rendering.

### Frontend — `TerminalExplorer` wiring

**New state:** `pendingArchive: SelectedEntry[] | null`, parallel to the
existing `pendingDelete` (line 81).

**Toolbar Archive button** (line 278) now calls `setPendingArchive(selectedEntries)`
instead of `zipSelected()` directly. On dialog confirm, the existing
`zipSelected` body runs with the user's filename instead of
`archiveFileName()`'s.

**New per-row Download button** in `TreeLevel` (line 519, before the existing
Delete button), styled to match the Delete button's `opacity-0
group-hover:opacity-100` reveal, with the lucide `Download` icon:

- `entry.isDir` → `onRequestArchive(selectedEntry)` → opens `ArchiveNameDialog`
  pre-filled `<folder>.zip` → confirm → existing zip flow → `downloadBlob`.
- otherwise → `onDownloadFile(selectedEntry)` → `downloadFile(path, name)` →
  `downloadBlob(blob, entry.name)`. No dialog: the file keeps its own name,
  and the browser's own save dialog handles renaming.

`TreeLevelProps` gains `onRequestArchive`, `onDownloadFile`, and
`downloadPending` (to disable the button mid-transfer, mirroring the existing
`deletePending` prop at line 397).

`archiveFileName()` (line 49) is retained — it now supplies the dialog's
*default* rather than the final name.

## Error handling

| Case | Behavior |
| --- | --- |
| Download a directory via the raw endpoint | Service returns `ErrValidation` → 400 `{"error": "\"x\" is a folder…"}`. Unreachable from the UI (the button branches on `isDir`), but guarded because the route is independently addressable. |
| File deleted between listing and download | `svc.resolve` → `fileOperationError` → 404 via `handleStoreErr`. |
| Path escaping the worktree root | `ensureInside` rejects before any I/O — unchanged existing behavior. |
| Network/transport failure | `machineXhr`/`apiXhr` reject with `ApiError`; `finishTransfer(id, 'error', …)` marks the transfer card failed, and the call site shows `toast.error(errorMessage(error, …))`, matching `zipSelected` (line 240). |
| Empty/whitespace archive name | Confirm button disabled; no request fires. |
| Blob error body | `machineXhr` can't parse a JSON error out of a `responseType: 'blob'` response, so it reports `Request failed with status N` (`machineClient.ts:167-169`). Pre-existing limitation shared with zip download; not addressed here. |

## Testing

**Backend** (`service/worktree_file_test.go`, `service/ssh_file_test.go` —
extending the existing `TestWorktreeFileServiceUploadDeleteManyAndArchive`
pattern at `worktree_file_test.go:141`):

- Download returns exact bytes for a UTF-8 text file.
- Download succeeds for a **binary** file (bytes with a NUL) — the case
  `Read` rejects. This is the test that proves the new capability.
- Download of a directory path returns `ErrValidation`.
- Download of a missing path returns an error (not a panic/empty 200).
- Download of `../` escape and of a symlink pointing outside the root are both
  rejected.
- `contentDisposition` unit test: plain ASCII, a name with `"`, and a
  non-ASCII name each produce a well-formed header.

**Frontend:**

- `normalizeArchiveName` unit test (trims, strips separators, appends `.zip`,
  leaves an existing `.zip` alone).
- Remaining coverage is manual QA — no test suite currently exercises
  `TerminalExplorer.tsx`. Verify against both a local worktree and an SSH
  connection: file-row download saves the raw file; a binary file (e.g. a PNG)
  downloads intact; folder-row download opens the dialog, respects a renamed
  archive, and produces a valid zip; the toolbar multi-select goes through the
  same dialog; Cancel fires no request; transfers appear in
  `TransferStatusPanel`.

## Files touched

**Backend**
- `internal/service/worktree_file.go` — add `Download`
- `internal/service/ssh_file.go` — add `Download`
- `internal/handler/worktree_file.go` — add `Download` handler
- `internal/handler/ssh_file.go` — add `Download` handler
- `internal/handler/` — add `contentDisposition` helper (shared)
- `cmd/server/main.go` — register two routes ⚠️ *convergence file — serialize this edit*
- `internal/service/worktree_file_test.go`, `internal/service/ssh_file_test.go`

**Frontend**
- `src/lib/machineApi.ts` — add `downloadWorktreeFileWithProgress`
- `src/lib/sshFileApi.ts` — add `downloadSSHFileWithProgress`, widen `XhrOpts`
- `src/features/terminal/useFileTransfers.ts` — add `downloadFile`, rename `zipping` → `downloading`
- `src/features/terminal/ArchiveNameDialog.tsx` — new
- `src/features/terminal/TerminalExplorer.tsx` — dialog state, toolbar rewire, per-row Download button
