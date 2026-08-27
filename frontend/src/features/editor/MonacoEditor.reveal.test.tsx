import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

/** One fake standalone editor instance, recording the reveal calls we care about. */
interface FakeInstance {
  selections: unknown[]
  revealed: unknown[]
  focused: number
  disposed: boolean
  /** Call names in order — the reveal has to re-measure *before* it scrolls. */
  calls: string[]
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
        const record: FakeInstance = {
          selections: [],
          revealed: [],
          focused: 0,
          disposed: false,
          calls: [],
        }
        instances.push(record)
        return {
          getModel: () => options.model,
          getValue: () => (options.model as { getValue: () => string }).getValue(),
          setValue: (next: string) => (options.model as { setValue: (v: string) => void }).setValue(next),
          layout: () => record.calls.push('layout'),
          setSelection: (range: unknown) => {
            record.calls.push('setSelection')
            record.selections.push(range)
          },
          revealRangeInCenter: (range: unknown) => {
            record.calls.push('revealRangeInCenter')
            record.revealed.push(range)
          },
          focus: () => {
            record.calls.push('focus')
            record.focused += 1
          },
          updateOptions: () => {},
          saveViewState: () => null,
          restoreViewState: () => {},
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

  // The reported bug: clicking through to a function whose file was ALREADY open
  // landed on line 1, while the same click into a not-yet-open file worked.
  // FileEditor keeps inactive tabs mounted under `display: none`, so that
  // editor was built 0x0 and still measured 0x0 in the commit that showed its
  // tab — and monaco clamps a reveal into a zero-height viewport to no scroll at
  // all. Re-measuring has to happen before the scroll, not after.
  it('re-measures the container before revealing', () => {
    render(
      <MonacoEditor
        path="src/main.go"
        modelKey="m:w:src/main.go"
        value="package main"
        ready
        reveal={{ startLine: 42, startColumn: 5, endLine: 42, endColumn: 9 }}
      />,
    )

    // The first four calls, not the whole log: the effect legitimately runs
    // twice on mount, once when the instance appears and again when the
    // `mounted` latch flips.
    expect(instances.at(-1)!.calls.slice(0, 4)).toEqual([
      'layout',
      'setSelection',
      'revealRangeInCenter',
      'focus',
    ])
  })

  // The other half of that fix: a reveal that arrives at a tab which is not
  // shown in the same commit is held, not dropped. jsdom reports every element
  // as zero-height, which is exactly the state being guarded, so this drives the
  // observer by hand.
  it('re-applies a jump that arrived while the tab was still hidden', () => {
    const fire: Array<() => void> = []
    const originalObserver = globalThis.ResizeObserver
    let height = 0
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => height,
    })
    // Honours disconnect(), so a superseded observer cannot re-fire.
    globalThis.ResizeObserver = class {
      active = true
      constructor(callback: ResizeObserverCallback) {
        fire.push(() => {
          if (this.active) callback([], this as unknown as ResizeObserver)
        })
      }
      observe() {}
      unobserve() {}
      disconnect() {
        this.active = false
      }
    } as unknown as typeof ResizeObserver

    const fireAll = () => fire.forEach((run) => run())

    try {
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
      // Fired blind into the collapsed container, and an observer left waiting.
      const blind = live.revealed.length
      expect(blind).toBeGreaterThan(0)
      expect(fire.length).toBeGreaterThan(0)

      // Nothing to re-apply while the container is still collapsed.
      fireAll()
      expect(live.revealed).toHaveLength(blind)

      height = 600
      fireAll()
      expect(live.revealed).toHaveLength(blind + 1)
      expect(live.revealed.at(-1)).toEqual({
        startLineNumber: 42,
        startColumn: 5,
        endLineNumber: 42,
        endColumn: 9,
      })

      // And only once — the observer disconnects itself on the way through.
      fireAll()
      expect(live.revealed).toHaveLength(blind + 1)
    } finally {
      globalThis.ResizeObserver = originalObserver
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
    }
  })
})
