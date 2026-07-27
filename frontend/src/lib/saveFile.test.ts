/**
 * Plain assertion-based tests, matching fileTreeSelection.test.ts's convention
 * (no Vitest/Jest configured in this project yet). Run manually with:
 *
 *   npx tsx src/lib/saveFile.test.ts
 *
 * Only the picker-selection logic is covered — the `<a download>` fallback
 * path needs a real DOM and is verified by hand in the browser.
 */

import { canPickSaveLocation, pickSaveTarget, SAVE_CANCELLED, type PickerWindow } from './saveFile'

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

  console.log(`\n${passed} passed`)
}

function stubWritable() {
  return {
    write: async () => {},
    close: async () => {},
  } as unknown as FileSystemWritableFileStream
}

void main()
