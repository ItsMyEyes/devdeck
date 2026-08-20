/**
 * Plan D2 — `ComposerSuggestionMenu`, the popup extracted out of
 * `composerMention.ts`'s private `MentionMenu` so D3 (`$` skills) and D4
 * (`/` commands) don't each write it a third time.
 *
 * Plain component tests — no ProseMirror/editor needed here at all;
 * `items`/`command`/`loading` are passed as mock props, exactly like a
 * `Suggestion` renderer would hand them in (D3/D4's own component tests
 * exercise the real tiptap wiring on top of this).
 */
import type { ComponentProps } from 'react'
import { createElement, createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { File } from 'lucide-react'

import { ComposerSuggestionMenu } from '@/features/agent-chat/ComposerSuggestionMenu'
import type { ComposerSuggestionMenuHandle, ComposerSuggestionMenuItem } from '@/features/agent-chat/ComposerSuggestionMenu'

afterEach(cleanup)

const ITEMS: ComposerSuggestionMenuItem[] = [
  { id: 'a', label: 'Alpha', icon: File },
  { id: 'b', label: 'Beta', description: 'the second one', icon: File },
]

// `ComposerSuggestionMenu`'s props extend the full `SuggestionProps` (editor,
// range, query, text, decorationNode, placement, offset, flip, floatingUi,
// mount, …) — fields the component never reads (it only destructures
// items/command/loading/itemTestAttr/errorMessage/emptyMessage) and that a
// real `Suggestion` plugin would normally supply. A component test exercises
// exactly the subset the component uses; the cast documents that the rest is
// intentionally omitted, not forgotten.
type MenuProps = ComponentProps<typeof ComposerSuggestionMenu>

function renderMenu(overrides: Partial<MenuProps> = {}) {
  const command = vi.fn()
  const ref = createRef<ComposerSuggestionMenuHandle>()
  const utils = render(
    createElement(ComposerSuggestionMenu, {
      items: ITEMS,
      command,
      loading: false,
      itemTestAttr: 'test-item',
      ref,
      ...overrides,
    } as MenuProps),
  )
  return { ...utils, command, ref }
}

describe('ComposerSuggestionMenu — states', () => {
  it('renders nothing for an empty, non-loading result with no emptyMessage', () => {
    const { container } = renderMenu({ items: [] })
    expect(container.firstChild).toBeNull()
  })

  it('renders a loading indicator for an empty, loading result', () => {
    const { getByText } = renderMenu({ items: [], loading: true })
    expect(getByText('Searching…')).toBeTruthy()
  })

  it('renders emptyMessage for an empty, non-loading result when provided', () => {
    const { getByText } = renderMenu({ items: [], emptyMessage: 'No skills found' })
    expect(getByText('No skills found')).toBeTruthy()
  })

  it('renders errorMessage instead of anything else, even mid-loading with items present', () => {
    const { getByText, queryByText } = renderMenu({ loading: true, errorMessage: "Couldn't load skills for claude" })
    expect(getByText("Couldn't load skills for claude")).toBeTruthy()
    expect(queryByText('Alpha')).toBeNull()
  })
})

describe('ComposerSuggestionMenu — list', () => {
  it('stamps each item with the given test attribute and shows label/description', () => {
    const { container, getByText } = renderMenu()
    expect(container.querySelector('[data-test-item="a"]')).not.toBeNull()
    expect(container.querySelector('[data-test-item="b"]')).not.toBeNull()
    expect(getByText('the second one')).toBeTruthy()
  })

  it('clicking an item calls command with that item', () => {
    const { container, command } = renderMenu()
    fireEvent.click(container.querySelector('[data-test-item="b"]') as HTMLButtonElement)
    expect(command).toHaveBeenCalledWith(ITEMS[1])
  })

  it('ArrowDown/ArrowUp cycle the highlight, Enter selects the highlighted item', () => {
    const { ref, command } = renderMenu()
    // The imperative handle is called directly here (this component's own
    // contract — tiptap's render().onKeyDown calls it the same way), not
    // through fireEvent, so each call needs its own act() to flush the
    // setHighlighted update before the next call reads it.
    let handled = false
    act(() => {
      handled = ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'ArrowDown' }) } as never)
    })
    expect(handled).toBe(true)
    act(() => {
      ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Enter' }) } as never)
    })
    expect(command).toHaveBeenCalledWith(ITEMS[1]) // started at 0 (Alpha), ArrowDown moved to 1 (Beta)
  })
})
