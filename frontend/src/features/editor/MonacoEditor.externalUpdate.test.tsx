import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

/** One fake instance, recording how a value swap was applied. */
interface FakeInstance {
  value: string
  /** Call names in order — restore has to happen *after* the swap. */
  calls: string[]
  restored: unknown[]
}

const instances: FakeInstance[] = []

vi.mock('./monacoSetup', () => {
  const monaco = {
    editor: {
      create: (_host: HTMLElement, options: { model: { getValue: () => string } }) => {
        const record: FakeInstance = { value: options.model.getValue(), calls: [], restored: [] }
        instances.push(record)
        // A stand-in for monaco's opaque ICodeEditorViewState: what matters is
        // that the exact object saved before the swap is handed back after it.
        const viewState = { scrollTop: 8_000 }
        return {
          getModel: () => options.model,
          getValue: () => record.value,
          setValue: (next: string) => {
            record.calls.push('setValue')
            record.value = next
          },
          saveViewState: () => {
            record.calls.push('saveViewState')
            return viewState
          },
          restoreViewState: (state: unknown) => {
            record.calls.push('restoreViewState')
            record.restored.push(state)
          },
          layout: () => {},
          setSelection: () => {},
          revealRangeInCenter: () => {},
          focus: () => {},
          updateOptions: () => {},
          onDidChangeModelContent: () => ({ dispose: () => {} }),
          dispose: () => {},
        }
      },
      createModel: (value: string) => ({
        getValue: () => value,
        setValue: () => {},
        getLineCount: () => 500,
        getLineMaxColumn: () => 200,
        dispose: () => {},
      }),
      defineTheme: () => {},
      setTheme: () => {},
    },
    Uri: { parse: (value: string) => value },
  }
  return { monaco, setupMonaco: () => monaco, DEVDECK_DARK: 'devdeck-dark' }
})

const { MonacoEditor } = await import('./MonacoEditor')

describe('MonacoEditor external value replacement', () => {
  beforeEach(() => {
    cleanup()
    instances.length = 0
  })

  // The regression this guards: a file tab now re-reads itself while it is on
  // screen and adopts what an agent wrote (terminal/fileBuffer.ts). `setValue`
  // resets the model, so without saving and restoring the view state, an
  // operator reading line 400 of a file the agent is editing gets thrown back
  // to line 1 every few seconds — a refresh nobody could work next to.
  it('keeps the viewport when the value is replaced from outside', () => {
    const props = { path: 'src/main.go', modelKey: 'm:w:src/main.go', ready: true }
    const view = render(<MonacoEditor {...props} value="package main" />)

    view.rerender(<MonacoEditor {...props} value="package main // agent was here" />)

    const live = instances.at(-1)!
    expect(live.value).toBe('package main // agent was here')
    expect(live.calls).toEqual(['saveViewState', 'setValue', 'restoreViewState'])
    expect(live.restored).toEqual([{ scrollTop: 8_000 }])
  })

  // The guard that predates this and must survive it: the editor echoes its own
  // content back through onChange, so an unchanged value must touch nothing at
  // all — restoring a view state on every keystroke would fight the cursor.
  it('does nothing when the value already matches the buffer', () => {
    const props = { path: 'src/main.go', modelKey: 'm:w:src/main.go', ready: true }
    const view = render(<MonacoEditor {...props} value="package main" />)
    instances.at(-1)!.calls.length = 0

    view.rerender(<MonacoEditor {...props} value="package main" />)

    expect(instances.at(-1)!.calls).toEqual([])
  })
})
