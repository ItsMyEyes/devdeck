import { useEffect } from 'react'
import type { RefObject } from 'react'
import { matchesBinding } from '@/features/keybindings/store'

/**
 * Puts the whole of `element` in the document selection.
 *
 * The problem this solves: Cmd/Ctrl+A over a *rendered* (non-editable) region
 * is handled by the browser against the whole document, so in an app shell it
 * selects the sidebar, the tab strips and every other pane along with the text
 * the user was actually reading. Scoping the range to one container is the
 * only way to make the chord mean "select this document".
 */
export function selectAllWithin(element: HTMLElement | null): boolean {
  if (!element) return false
  const selection = window.getSelection?.()
  if (!selection) return false
  const range = element.ownerDocument.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

/**
 * Targets that already scope Select All correctly on their own, and must be
 * left alone.
 *
 * `<input>`/`<textarea>` get it from the browser. A contenteditable gets it
 * from whatever editor owns it — for every one of these surfaces that means
 * Tiptap, whose core keymap binds `Mod-a` to ProseMirror's `selectAll`.
 * Overriding that with a raw DOM range would replace an editor selection the
 * user can type over with one that is only good for copying, and would leave
 * ProseMirror holding a selection it cannot map back to its document.
 */
function handlesOwnSelectAll(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element.tagName !== 'string') return false
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') return true
  return element.isContentEditable === true
}

export interface SelectAllScopeOptions {
  enabled?: boolean
  /**
   * Claims the chord instead of the default DOM selection. Return `true` when
   * handled — the WYSIWYG surfaces route it to ProseMirror's own `selectAll`,
   * which produces an editor selection you can then type over, where a raw DOM
   * range would only be good for copying.
   *
   * Returning `false` falls through to selecting `ref`'s contents.
   */
  onSelectAll?: (event: KeyboardEvent) => boolean | void
}

/**
 * Binds "Select all" inside one container.
 *
 * Deliberately per-surface rather than one global listener: a window-level
 * Cmd+A that guessed at the right scope would eventually guess wrong over
 * someone's text field, and every other chord in this app is scoped by
 * `contains` for the same reason (see Terminal.tsx's find shortcut).
 */
export function useSelectAllScope(
  ref: RefObject<HTMLElement | null>,
  { enabled = true, onSelectAll }: SelectAllScopeOptions = {},
) {
  useEffect(() => {
    if (!enabled) return
    function handleKeydown(event: KeyboardEvent) {
      if (!matchesBinding(event, 'document.selectAll')) return
      const root = ref.current
      if (!root || !root.contains(event.target as Node)) return
      // A find bar, a title field, or the WYSIWYG canvas itself keeps its own
      // Select All — the user is editing that box, not reading the document.
      if (handlesOwnSelectAll(event.target)) return

      if (onSelectAll?.(event) === true) {
        event.preventDefault()
        return
      }
      if (selectAllWithin(root)) event.preventDefault()
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [enabled, onSelectAll, ref])
}
