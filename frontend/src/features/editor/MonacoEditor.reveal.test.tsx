import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

/** One fake standalone editor instance, recording the reveal calls we care about. */
interface FakeInstance {
  selections: unknown[]
  revealed: unknown[]
  focused: number
  disposed: boolean
}

const instances: FakeInstance[] = []

function createFakeModel(value: string) {
  let text = value
  return {
    getValue: () => text,
    setValue: (next: string) => {
      text = next
    },
    getLineCount: () => 500,
    getLineMaxColumn: () => 200,
    dispose: () => {},
  }
}

vi.mock('./monacoSetup', () => {
  const monaco = {
    editor: {
      create: (_host: HTMLElement, options: { model: unknown }) => {
        const record: FakeInstance = { selections: [], revealed: [], focused: 0, disposed: false }
        instances.push(record)
        return {
          getModel: () => options.model,
          getValue: () => (options.model as { getValue: () => string }).getValue(),
          setValue: (next: string) => (options.model as { setValue: (v: string) => void }).setValue(next),
          setSelection: (range: unknown) => record.selections.push(range),
          revealRangeInCenter: (range: unknown) => record.revealed.push(range),
          focus: () => {
            record.focused += 1
          },
          updateOptions: () => {},
          onDidChangeModelContent: () => ({ dispose: () => {} }),
          dispose: () => {
            record.disposed = true
          },
        }
      },
      createModel: (value: string) => createFakeModel(value),
      defineTheme: () => {},
      setTheme: () => {},
    },
    Uri: { parse: (value: string) => value },
  }
  return { monaco, setupMonaco: () => monaco, DEVDECK_DARK: 'devdeck-dark' }
})

const { MonacoEditor } = await import('./MonacoEditor')

describe('MonacoEditor reveal', () => {
  beforeEach(() => {
    cleanup()
    instances.length = 0
  })

  it('reveals the range once the file content is ready', () => {
    render(
      <MonacoEditor
        path="src/main.go"
        modelKey="m:w:src/main.go"
        value="package main"
        ready
        reveal={{ startLine: 42, startColumn: 5, endLine: 42, endColumn: 9 }}
      />,
    )

    const live = instances.at(-1)!
    expect(live.revealed.at(-1)).toEqual({
      startLineNumber: 42,
      startColumn: 5,
      endLineNumber: 42,
      endColumn: 9,
    })
  })

  // The regression: `uri` legitimately starts undefined and flips to the LSP
  // session's real `file://` address after mount, which recreates the editor
  // instance on a brand-new model scrolled to the top. Content search's jump
  // must survive that swap.
  it('re-applies the reveal to the instance rebuilt when the LSP uri resolves', () => {
    const reveal = { startLine: 42, startColumn: 5, endLine: 42, endColumn: 9 }
    const view = render(
      <MonacoEditor
        path="src/main.go"
        modelKey="m:w:src/main.go"
        value="package main"
        ready
        reveal={reveal}
      />,
    )
    expect(instances).toHaveLength(1)

    view.rerender(
      <MonacoEditor
        path="src/main.go"
        modelKey="m:w:src/main.go"
        uri="file:///w/src/main.go"
        value="package main"
        ready
        reveal={reveal}
      />,
    )

    expect(instances).toHaveLength(2)
    expect(instances[1].revealed.at(-1)).toEqual({
      startLineNumber: 42,
      startColumn: 5,
      endLineNumber: 42,
      endColumn: 9,
    })
  })

  // The real ordering behind the reported bug: a content-search click opens a
  // tab whose file body is still loading, the body lands, and only then does
  // the language server hand back the document uri.
  it('survives the real open sequence: content loads, then the LSP uri arrives', () => {
    const reveal = { startLine: 42, startColumn: 5, endLine: 42, endColumn: 9 }
    const props = { path: 'src/main.go', modelKey: 'm:w:src/main.go', reveal }

    const view = render(<MonacoEditor {...props} value="" ready={false} />)
    expect(instances[0].revealed).toHaveLength(0)

    view.rerender(<MonacoEditor {...props} value="package main" ready />)
    expect(instances[0].revealed.at(-1)).toBeDefined()

    view.rerender(
      <MonacoEditor {...props} uri="file:///w/src/main.go" value="package main" ready />,
    )

    expect(instances).toHaveLength(2)
    expect(instances[1].revealed.at(-1)).toEqual({
      startLineNumber: 42,
      startColumn: 5,
      endLineNumber: 42,
      endColumn: 9,
    })
  })
})
