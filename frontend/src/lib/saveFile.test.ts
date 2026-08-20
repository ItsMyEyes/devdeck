/**
 * Plain assertion-based tests, matching fileTreeSelection.test.ts's convention
 * (no Vitest/Jest configured in this project yet). Run manually with:
 *
 *   npx tsx src/lib/saveFile.test.ts
 *
 * Only the picker-selection logic is covered — the `<a download>` fallback
 * path needs a real DOM and is verified by hand in the browser.
 */

import {
  canPickSaveLocation,
  pickSaveTarget,
  SAVE_CANCELLED,
  saveBlob,
  type PickerWindow,
  type TauriSaveApi,
} from './saveFile'

let passed = 0

function check(name: string, fn: () => void | Promise<void>) {
  const done = () => {
    passed += 1
    console.log(`ok - ${name}`)
  }
  try {
    const result = fn()
    if (result instanceof Promise) {
      return result.then(done, (error) => {
        console.error(`FAIL - ${name}`)
        console.error(error)
        process.exitCode = 1
      })
    }
    done()
  } catch (error) {
    console.error(`FAIL - ${name}`)
    console.error(error)
    process.exitCode = 1
  }
  return Promise.resolve()
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

/** Node has DOMException globally, so an AbortError can be faked faithfully. */
function abortError() {
  return new DOMException('The user aborted a request.', 'AbortError')
}

/** A window that looks like the desktop shell: Tauri's IPC, no picker. */
function tauriWindow(): PickerWindow {
  return { __TAURI_INTERNALS__: {} } as unknown as PickerWindow
}

/** Records what the Tauri dialog was asked for and what got written. */
function stubTauriApi(path: string | null) {
  const calls: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }[] = []
  const writes: { path: string; bytes: Uint8Array }[] = []
  const api: TauriSaveApi = {
    save: async (options) => {
      calls.push(options)
      return path
    },
    writeFile: async (target, bytes) => {
      writes.push({ path: target, bytes })
    },
  }
  return { api, calls, writes, load: async () => api }
}

async function main() {
  await check('canPickSaveLocation is false when the API is absent', () => {
    assert(canPickSaveLocation({} as PickerWindow) === false, 'expected false without the picker')
  })

  await check('canPickSaveLocation is true when the API is present', () => {
    const win: PickerWindow = { showSaveFilePicker: async () => ({}) as FileSystemFileHandle }
    assert(canPickSaveLocation(win) === true, 'expected true with the picker')
  })

  await check('pickSaveTarget passes the suggested name to the native dialog', async () => {
    let seen: string | undefined
    const win: PickerWindow = {
      showSaveFilePicker: async (options) => {
        seen = options?.suggestedName
        return { createWritable: async () => stubWritable() } as unknown as FileSystemFileHandle
      },
    }
    await pickSaveTarget('report.zip', win)
    assert(seen === 'report.zip', `expected suggestedName "report.zip", got ${String(seen)}`)
  })

  await check('pickSaveTarget reports cancellation when the user dismisses the dialog', async () => {
    const win: PickerWindow = {
      showSaveFilePicker: async () => {
        throw abortError()
      },
    }
    const target = await pickSaveTarget('x.zip', win)
    assert(target === SAVE_CANCELLED, 'expected SAVE_CANCELLED for an AbortError')
  })

  await check('pickSaveTarget falls back instead of cancelling on a non-abort failure', async () => {
    const win: PickerWindow = {
      showSaveFilePicker: async () => {
        throw new DOMException('Must be handling a user gesture.', 'SecurityError')
      },
    }
    const target = await pickSaveTarget('x.zip', win)
    assert(target !== SAVE_CANCELLED, 'a SecurityError must fall back, not cancel the download')
  })

  await check('pickSaveTarget writes the blob and closes the stream', async () => {
    const written: Blob[] = []
    let closed = false
    const win: PickerWindow = {
      showSaveFilePicker: async () =>
        ({
          createWritable: async () => ({
            write: async (blob: Blob) => {
              written.push(blob)
            },
            close: async () => {
              closed = true
            },
          }),
        }) as unknown as FileSystemFileHandle,
    }
    const target = await pickSaveTarget('x.zip', win)
    assert(target !== SAVE_CANCELLED, 'expected a writable target')
    if (target === SAVE_CANCELLED) return
    await target.write(new Blob(['hello']))
    assert(written.length === 1, `expected 1 write, got ${written.length}`)
    assert(closed, 'expected the writable stream to be closed')
  })

  await check('pickSaveTarget closes the stream even when writing fails', async () => {
    let closed = false
    const win: PickerWindow = {
      showSaveFilePicker: async () =>
        ({
          createWritable: async () => ({
            write: async () => {
              throw new Error('disk full')
            },
            close: async () => {
              closed = true
            },
          }),
        }) as unknown as FileSystemFileHandle,
    }
    const target = await pickSaveTarget('x.zip', win)
    if (target === SAVE_CANCELLED) throw new Error('expected a writable target')
    let threw = false
    try {
      await target.write(new Blob(['hello']))
    } catch {
      threw = true
    }
    assert(threw, 'expected the write error to propagate')
    assert(closed, 'expected the stream to be closed despite the write failure')
  })

  // The desktop tier. This is the whole point of the module: inside the app
  // shell there is no showSaveFilePicker and `<a download>` is swallowed, so
  // without these branches every export button is a silent no-op.

  await check('canPickSaveLocation is true inside the desktop shell', () => {
    assert(canPickSaveLocation(tauriWindow()) === true, 'expected true with Tauri IPC present')
  })

  await check('pickSaveTarget opens the OS panel with a name and a type filter', async () => {
    const tauri = stubTauriApi('/Users/me/Desktop/report.zip')
    await pickSaveTarget('report.zip', tauriWindow(), tauri.load)
    assert(tauri.calls.length === 1, `expected 1 dialog, got ${tauri.calls.length}`)
    assert(tauri.calls[0].defaultPath === 'report.zip', 'expected the suggested name as defaultPath')
    assert(
      tauri.calls[0].filters?.[0]?.extensions[0] === 'zip',
      'expected a .zip filter so the panel keeps the extension',
    )
  })

  await check('pickSaveTarget sends no filter for an extensionless name', async () => {
    const tauri = stubTauriApi('/Users/me/Desktop/notes')
    await pickSaveTarget('notes', tauriWindow(), tauri.load)
    assert(tauri.calls[0].filters === undefined, 'expected no filter when there is no extension')
  })

  await check('pickSaveTarget treats a dismissed OS panel as a cancellation', async () => {
    const tauri = stubTauriApi(null)
    const target = await pickSaveTarget('x.zip', tauriWindow(), tauri.load)
    assert(target === SAVE_CANCELLED, 'expected SAVE_CANCELLED when save() resolves to null')
  })

  await check('saveBlob writes the bytes to the picked desktop path', async () => {
    const tauri = stubTauriApi('/Users/me/Desktop/x.txt')
    const saved = await saveBlob(new Blob(['hello']), 'x.txt', tauriWindow(), tauri.load)
    assert(saved, 'expected saveBlob to report a completed save')
    assert(tauri.writes.length === 1, `expected 1 write, got ${tauri.writes.length}`)
    assert(tauri.writes[0].path === '/Users/me/Desktop/x.txt', 'expected the path the user picked')
    assert(
      new TextDecoder().decode(tauri.writes[0].bytes) === 'hello',
      'expected the blob bytes to reach writeFile intact',
    )
  })

  await check('saveBlob reports false when the desktop panel is dismissed', async () => {
    const tauri = stubTauriApi(null)
    const saved = await saveBlob(new Blob(['hello']), 'x.txt', tauriWindow(), tauri.load)
    assert(saved === false, 'a dismissed dialog must not be reported as a successful save')
    assert(tauri.writes.length === 0, 'expected nothing written after a cancellation')
  })

  console.log(`\n${passed} passed`)
}

function stubWritable() {
  return {
    write: async () => {},
    close: async () => {},
  } as unknown as FileSystemWritableFileStream
}

void main()
