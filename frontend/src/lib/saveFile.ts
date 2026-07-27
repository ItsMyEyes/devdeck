// Saving a downloaded Blob to disk, preferring the OS's own save dialog.
//
// The `<a download>` fallback drops the file straight into the browser's
// Downloads folder with no way to choose a location. The File System Access
// API's showSaveFilePicker() opens the real native dialog instead, but it
// only exists in Chromium browsers (Chrome/Edge/Brave) and only in a secure
// context — Safari, Firefox, and Tauri's macOS WKWebView all lack it, so
// every entry point here degrades to the anchor.

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
 * Whether this browser can open a native save dialog. Split out from
 * pickSaveTarget so it stays testable without a DOM, and so callers can skip
 * their own rename prompt when the OS dialog will collect a name anyway.
 */
export function canPickSaveLocation(win: PickerWindow = window): boolean {
  return typeof win.showSaveFilePicker === 'function'
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
 * Opens the native save dialog and returns a handle to write to later, or a
 * fallback target that saves to the Downloads folder.
 *
 * MUST be called before the first `await` of the click handler that triggers
 * it. showSaveFilePicker() requires *transient* user activation, which expires
 * a few seconds after the click — so opening the dialog after the download
 * finishes would throw SecurityError on anything but a tiny file. Picking the
 * destination first also reads better: choose where it goes, then watch it
 * download.
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
): Promise<SaveTarget | typeof SAVE_CANCELLED> {
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
