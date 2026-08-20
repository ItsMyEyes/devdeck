import { act, render, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it } from 'vitest'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { ToastHost } from './ToastHost'

function blockers() {
  return Object.values(useDevDeckStore.getState().nativeOverlayBlockers)
}

describe('ToastHost', () => {
  afterEach(() => {
    act(() => {
      toast.dismiss()
    })
  })

  // Asserted on the toast itself rather than on the toaster: sonner renders no
  // list at all until something is in it, and these two attributes are what its
  // stylesheet anchors the corner and the slide-in direction to.
  it('puts every toast in the bottom-right corner', async () => {
    render(<ToastHost />)
    act(() => {
      toast('Copied path to clipboard')
    })

    await waitFor(() => {
      const element = document.querySelector('[data-sonner-toast]')
      expect(element).toHaveAttribute('data-y-position', 'bottom')
      expect(element).toHaveAttribute('data-x-position', 'right')
    })
  })

  // Without this a toast in the bottom-right corner is simply invisible on
  // desktop whenever a Browser tile is open there: that tile is a native webview
  // painted above the whole DOM. The blocker makes `visibleTileRect` cut the
  // webview back instead — see ToastHost's doc comment.
  it('shields the toast stack from a Browser tile only while a toast is up', async () => {
    render(<ToastHost />)
    expect(blockers()).toHaveLength(0)

    act(() => {
      toast.success('Saved README.md')
    })
    await waitFor(() => expect(blockers()).toHaveLength(1))

    act(() => {
      toast.dismiss()
    })
    await waitFor(() => expect(blockers()).toHaveLength(0))
  })

  // The toasts are `unstyled`, which makes ToastHost's own classes the entire
  // design: sonner injects its stylesheet at runtime, outside our cascade
  // layers, where it outranks every utility class. Dropping `unstyled` would
  // silently hand the styling back to sonner (including a hardcoded #3f3f3f
  // description colour on a dark surface), so the surface class is asserted.
  it('renders a typed toast with its message, description and icon slot', async () => {
    render(<ToastHost />)
    act(() => {
      toast.error('Could not write settings.json', { description: 'EACCES: permission denied' })
    })

    const element = await waitFor(() => {
      const found = document.querySelector('[data-sonner-toast]')
      expect(found).not.toBeNull()
      return found!
    })

    expect(element.textContent).toContain('Could not write settings.json')
    expect(element.textContent).toContain('EACCES: permission denied')
    expect(element.querySelector('[data-icon]')).not.toBeNull()
    expect(element.className).toContain('bg-devdeck-glass')
  })
})
