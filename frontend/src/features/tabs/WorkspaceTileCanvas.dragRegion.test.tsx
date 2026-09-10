// Which parts of the tab strip drag the OS window, pinned as a test.
//
// On Windows and Linux the strip IS the title bar: those builds run
// `decorations: false` (tauri.windows.conf.json / tauri.linux.conf.json), so
// unlike macOS — which keeps a real native title bar under
// `titleBarStyle: "Overlay"` and hit-tests it itself — nothing moves the
// window unless the DOM opts in with `data-tauri-drag-region`. That makes
// this the one platform fork with no fallback: get the markers wrong and the
// window cannot be moved at all, and no test that only renders the strip
// would notice.
//
// So this file does not assert on the attribute. It ports Tauri's own
// `isDragRegion` from tauri-2.11.5/src/window/scripts/drag.js verbatim and
// runs it over the real rendered DOM, which is what actually decides whether
// a mousedown becomes a window drag. The two rules that matter:
//
//   - every non-interactive part of the top strip drags the window, and
//   - nothing interactive does — tabs must stay draggable between panes,
//     and every button must stay clickable.
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { WorkspaceTileCanvas } from './WorkspaceTileCanvas'
import type { WorkspaceTileCanvasProps } from './WorkspaceTileCanvas'
import type { TileLeaf, TileNode, TileTab } from './tileTree'

afterEach(() => {
  cleanup()
})

// ---- tauri-2.11.5/src/window/scripts/drag.js, transcribed ----

const CLICKABLE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY'])
const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option'])

function isClickableElement(el: HTMLElement): boolean {
  return (
    CLICKABLE_TAGS.has(el.tagName) ||
    (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') ||
    (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') ||
    INTERACTIVE_ROLES.has(el.getAttribute('role') ?? '')
  )
}

function isDragRegion(composedPath: Element[]): boolean {
  for (const el of composedPath) {
    if (!(el instanceof HTMLElement)) continue

    const attr = el.getAttribute('data-tauri-drag-region')

    // clickable without explicit drag region → blocks drag
    if (isClickableElement(el) && attr === null) return false
    // no attr → keep walking up
    if (attr === null) continue
    // explicitly disabled
    if (attr === 'false') return false
    // subtree drag — any descendant triggers
    if (attr === 'deep') return true
    // bare or "true" attr — only direct clicks on this element
    if (attr === '' || attr === 'true') return el === composedPath[0]
  }

  return false
}

/** `Event.composedPath()` for a mousedown whose target is `el`. Elements only
 *  — `isDragRegion` skips everything that is not an `HTMLElement`, which is
 *  what makes an `<svg>` icon inside a caption button fall through to the
 *  button rather than answering for itself. */
function pathFrom(el: Element): Element[] {
  const path: Element[] = []
  for (let node: Element | null = el; node; node = node.parentElement) path.push(node)
  return path
}

/** True when pressing `el` would start a window drag. */
function dragsWindow(el: Element | null | undefined): boolean {
  expect(el, 'element under test is not in the DOM').toBeTruthy()
  return isDragRegion(pathFrom(el as Element))
}

// ---- fixtures ----

const AGENTS: TileTab = { kind: 'agents', id: 'agents' }
const worktreeTab = (id: string): TileTab => ({ kind: 'worktree', id, projectId: 'p1', wtId: id })

function leaf(id: string, tabs: TileTab[], activeTabId: string): TileLeaf {
  return { type: 'leaf', id, tabs, activeTabId }
}

const renderers: WorkspaceTileCanvasProps['renderers'] = {
  agents: () => <div data-testid="body-agents" />,
  worktree: ({ tab }) => <div data-testid={`body-${tab.wtId}`} />,
  browser: () => <div data-testid="body-browser" />,
  sshShell: () => <div data-testid="body-ssh" />,
}

function canvas(root: TileNode, focusedLeafId: string) {
  return (
    <WorkspaceTileCanvas
      root={root}
      focusedLeafId={focusedLeafId}
      renderers={renderers}
      onTreeChange={() => {}}
      onFocusLeaf={() => {}}
      onSelectTab={() => {}}
      onCloseTab={() => {}}
      onNewTab={() => {}}
      resolveWorktreeTab={(tab) => ({ title: tab.wtId, prefix: 'proj/local', name: tab.wtId })}
      resolveBrowserTab={() => ({ label: 'Web' })}
      resolveSSHShellTab={() => ({ label: 'SSH' })}
    />
  )
}

/** The top chrome strip. It is the element that holds the "New tab" button,
 *  found that way rather than by class so the query does not re-encode the
 *  styling this file is not testing. jsdom reports no Tauri global, so
 *  `useIsMacTauri()` is false and the strip renders its Windows/Linux shape:
 *  caption buttons instead of a traffic-light gutter. */
function topStrip(): HTMLElement {
  return screen.getAllByRole('button', { name: 'New tab' })[0].parentElement as HTMLElement
}

function scroller(strip: HTMLElement): Element | null {
  return strip.querySelector('.overflow-x-auto')
}

describe('top chrome strip drag regions', () => {
  it('drags the window from the strip itself', () => {
    render(canvas(leaf('leaf-1', [AGENTS], 'agents'), 'leaf-1'))
    expect(dragsWindow(topStrip())).toBe(true)
  })

  it('drags the window from the tab scroller — its empty space is most of the strip', () => {
    render(canvas(leaf('leaf-1', [AGENTS], 'agents'), 'leaf-1'))
    // The scroller carries no marker of its own. A bare `data-tauri-drag-region`
    // here would answer "only a direct click on this exact element" and end the
    // walk, which is precisely what stopped the separators and padding below
    // from dragging.
    expect(scroller(topStrip())?.hasAttribute('data-tauri-drag-region')).toBe(false)
    expect(dragsWindow(scroller(topStrip()))).toBe(true)
  })

  it('drags the window from the filler beside the caption buttons', () => {
    render(canvas(leaf('leaf-1', [AGENTS], 'agents'), 'leaf-1'))
    const filler = screen.getAllByRole('button', { name: 'New tab' })[0].nextElementSibling
    expect(dragsWindow(filler)).toBe(true)
  })

  it('drags the window from a separator between two tabs', () => {
    // Two consecutive UNselected tabs are what puts a separator on screen.
    render(canvas(leaf('leaf-1', [AGENTS, worktreeTab('wt-a'), worktreeTab('wt-b')], 'agents'), 'leaf-1'))
    const separator = topStrip().querySelector('.w-px')
    expect(dragsWindow(separator)).toBe(true)
  })
})

describe('what must never drag the window', () => {
  it('leaves tabs draggable between panes', () => {
    render(canvas(leaf('leaf-1', [AGENTS, worktreeTab('wt-a')], 'agents'), 'leaf-1'))
    const tab = screen.getByTitle(/wt-a/)
    // Both the tab and anything inside it: a press on the label starts a
    // dnd-kit tab drag, and a window drag would swallow the gesture.
    expect(dragsWindow(tab)).toBe(false)
    expect(dragsWindow(tab.querySelector('span') ?? tab)).toBe(false)
  })

  it('leaves the caption buttons and "New tab" clickable', () => {
    render(canvas(leaf('leaf-1', [AGENTS], 'agents'), 'leaf-1'))
    for (const name of ['Minimize', 'Maximize', 'Close', 'New tab']) {
      const button = screen.getAllByRole('button', { name })[0]
      expect(dragsWindow(button), `${name} must not drag the window`).toBe(false)
      // The icon inside it is an <svg>, which the walk skips — it must resolve
      // through the button, not through the strip above it.
      expect(dragsWindow(button.querySelector('svg') ?? button), `${name} icon`).toBe(false)
    }
  })

  it('leaves a split pane header alone — it is not a title bar', () => {
    const split: TileNode = {
      type: 'split',
      id: 'split-1',
      direction: 'column',
      children: [leaf('leaf-1', [AGENTS], 'agents'), leaf('leaf-2', [worktreeTab('wt-a')], 'wt-a')],
      sizes: [0.5, 0.5],
    }
    render(canvas(split, 'leaf-1'))

    // In a column split only the first child touches the window's top edge, so
    // the second leaf's strip is an in-pane header. Dragging the OS window from
    // there would be wrong, and `deep` is scoped to `topChrome` to prevent it.
    const paneHeader = screen.getAllByRole('button', { name: 'New tab' })[1].parentElement
    expect(dragsWindow(paneHeader)).toBe(false)
    expect(dragsWindow(scroller(paneHeader as HTMLElement))).toBe(false)
  })
})
