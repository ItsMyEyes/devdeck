// Saving a downloaded Blob to disk, preferring the OS's own save dialog.
//
// Three tiers, in order of preference:
//
//  1. Tauri (the desktop app) — the dialog plugin's save() is the real
//     NSSavePanel/IFileSaveDialog, and the fs plugin writes the bytes. This
//     tier exists because the desktop app had *no working download at all*:
//     WKWebView has no showSaveFilePicker, and its `<a download>` on a blob:
//     URL is swallowed silently, because wry only installs a WKDownloadDelegate
//     when the app registers a download handler — which this app does not. So
//     every export in the desktop build looked like a no-op, or (on the WebView2
//     side) dropped into Downloads with nothing asked.
//  2. showSaveFilePicker() — the File System Access API's native dialog. Only
//     Chromium browsers (Chrome/Edge/Brave), only in a secure context, and only
//     while the click's transient activation is still alive.
//  3. `<a download>` — Safari and Firefox. Drops the file straight into the
//     browser's Downloads folder with no way to choose a location.

/** Minimal shape of the File System Access API bits we use — not in TS's DOM lib. */
interface SaveFilePickerOptions {
  suggestedName?: string
}

type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>

declare global {
  interface Window {
    showSaveFilePicker?: SaveFilePicker
  }
}

/** The window, narrowed to the picker, so tests can pass a stub instead. */
export type PickerWindow = Pick<Window, 'showSaveFilePicker'>

/**
 * Whether we are running inside the Tauri shell, and can therefore reach the
 * OS save panel over IPC. Mirrors `useIsTauri()` rather than importing it —
 * this module is plain TS with no React, and is unit-tested against a stub
 * window that has neither key.
 */
function hasTauriIpc(win: PickerWindow): boolean {
  return '__TAURI_INTERNALS__' in win
}

/**
 * Whether this runtime can open a native save dialog. Split out from
 * pickSaveTarget so it stays testable without a DOM, and so callers can skip
 * their own rename prompt when the OS dialog will collect a name anyway.
 */
export function canPickSaveLocation(win: PickerWindow = window): boolean {
  return typeof win.showSaveFilePicker === 'function' || hasTauriIpc(win)
}

/** The user dismissed the native dialog — not an error, just nothing to do. */
export const SAVE_CANCELLED = Symbol('save-cancelled')

/** A destination chosen up front, written to once the bytes have arrived. */
export interface SaveTarget {
  write: (blob: Blob) => Promise<void>
}

function saveViaAnchor(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * The save panel's file-type filter, derived from the suggested name.
 *
 * Without it macOS shows "All Files" and happily saves `report.zip` as
 * `report` if the user edits the name field, and Windows appends nothing. The
 * extension is also what the dialog re-appends when the user retypes the stem.
 * Names with no extension get no filter rather than a bogus one.
 */
function extensionFilter(suggestedName: string) {
  const ext = suggestedName.split('/').pop()?.match(/\.([A-Za-z0-9]+)$/)?.[1]
  if (!ext) return undefined
  return [{ name: ext.toUpperCase(), extensions: [ext] }]
}

/**
 * The two Tauri plugin calls the desktop tier needs, as a value tests can
 * substitute — the real ones are only reachable inside the app shell.
 */
export interface TauriSaveApi {
  save: (options: {
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
  }) => Promise<string | null>
  writeFile: (path: string, data: Uint8Array) => Promise<void>
}

/**
 * Loads the desktop save plugins.
 *
 * The two are a pair by design — `save()` registers the chosen path in the fs
 * plugin's runtime scope for the rest of the session, which is the only reason
 * `writeFile` is allowed to touch it. The capability grants
 * `fs:allow-write-file` with no static `fs:scope`, so nothing outside a path
 * the user personally picked in a dialog is ever writable.
 *
 * Dynamically imported: web builds never execute this branch, and static
 * imports would pull the Tauri IPC shims into the browser bundle.
 */
async function loadTauriSaveApi(): Promise<TauriSaveApi> {
  const [dialog, fs] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])
  return { save: dialog.save, writeFile: fs.writeFile }
}

/** The desktop tier: the OS save panel, then a write to the path it returned. */
async function pickTauriSaveTarget(
  suggestedName: string,
  loadApi: () => Promise<TauriSaveApi>,
): Promise<SaveTarget | typeof SAVE_CANCELLED> {
  const api = await loadApi()
  const path = await api.save({
    defaultPath: suggestedName,
    filters: extensionFilter(suggestedName),
  })
  // save() resolves to null when the panel is dismissed — the desktop
  // equivalent of showSaveFilePicker's AbortError, not a failure.
  if (!path) return SAVE_CANCELLED

  return {
    write: async (blob) => {
      await api.writeFile(path, new Uint8Array(await blob.arrayBuffer()))
    },
  }
}

/**
 * Opens the native save dialog and returns a handle to write to later, or a
 * fallback target that saves to the Downloads folder.
 *
 * SHOULD be called before the first `await` of the click handler that triggers
 * it. Tier 2's showSaveFilePicker() requires *transient* user activation, which
 * expires a few seconds after the click — so opening the dialog after the
 * download finishes would throw SecurityError on anything but a tiny file. (The
 * desktop tier has no such rule, but callers cannot know which tier they will
 * land on, so the ordering is the contract everywhere.) Picking the destination
 * first also reads better: choose where it goes, then watch it download.
 *
 * Returns SAVE_CANCELLED if the user dismissed the dialog, so the caller can
 * skip the download entirely rather than fetching bytes nobody wants.
 *
 * Trade-off of picking first: Chromium creates the file as soon as the dialog
 * is confirmed, so a download that fails afterwards leaves a 0-byte file
 * behind. The caller's error toast is what tells the user to discard it.
 */
export async function pickSaveTarget(
  suggestedName: string,
  win: PickerWindow = window,
  loadTauriApi: () => Promise<TauriSaveApi> = loadTauriSaveApi,
): Promise<SaveTarget | typeof SAVE_CANCELLED> {
  // Checked before showSaveFilePicker: the desktop shell never has the picker
  // today, but if a future WebKit ships it the OS panel over IPC is still the
  // better path — it is not bound by transient activation, so it survives the
  // "pick after the download finished" case that makes tier 2 throw.
  if (hasTauriIpc(win)) {
    try {
      return await pickTauriSaveTarget(suggestedName, loadTauriApi)
    } catch {
      // A missing plugin or a denied capability must not strand the user with
      // no download at all — same reasoning as the picker's catch below.
      return { write: async (blob) => saveViaAnchor(blob, suggestedName) }
    }
  }

  const picker = win.showSaveFilePicker
  if (typeof picker !== 'function') {
    return { write: async (blob) => saveViaAnchor(blob, suggestedName) }
  }

  let handle: FileSystemFileHandle
  try {
    handle = await picker.call(win, { suggestedName })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return SAVE_CANCELLED
    // SecurityError (activation expired) or a picker the browser refused to
    // open — fall back rather than stranding the user with no download at all.
    return { write: async (blob) => saveViaAnchor(blob, suggestedName) }
  }

  return {
    write: async (blob) => {
      const writable = await handle.createWritable()
      try {
        await writable.write(blob)
      } catch (error) {
        await writable.close().catch(() => {})
        throw error
      }
      await writable.close()
    },
  }
}

/**
 * Saves bytes that are *already in hand* — the one-shot form of pickSaveTarget
 * for every "export what is on screen" button.
 *
 * Call it directly from the click handler, with nothing awaited before it, or
 * tier 2 loses its transient activation and silently degrades to Downloads.
 * When the bytes still have to be fetched, use pickSaveTarget() first and hold
 * the target across the fetch instead.
 *
 * Returns false when the user dismissed the dialog, so callers can skip their
 * "Exported!" toast rather than claiming a save that never happened.
 */
export async function saveBlob(
  blob: Blob,
  filename: string,
  win: PickerWindow = window,
  loadTauriApi: () => Promise<TauriSaveApi> = loadTauriSaveApi,
): Promise<boolean> {
  const target = await pickSaveTarget(filename, win, loadTauriApi)
  if (target === SAVE_CANCELLED) return false
  await target.write(blob)
  return true
}

/** saveBlob for text content, so callers stop hand-rolling the Blob + MIME. */
export function saveText(
  text: string,
  filename: string,
  mime = 'text/plain;charset=utf-8',
  win: PickerWindow = window,
): Promise<boolean> {
  return saveBlob(new Blob([text], { type: mime }), filename, win)
}
