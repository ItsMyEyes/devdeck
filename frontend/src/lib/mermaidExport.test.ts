import { describe, expect, it, vi } from 'vitest'
import { prerenderMermaidForExport } from './mermaidExport'

// The real thing is a multi-megabyte lazy chunk with its own rendering
// engine; what these tests are about is which fences reach it and how the
// result gets spliced back into the surrounding markdown, not what it draws.
const render_ = vi.hoisted(() => vi.fn())
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: render_ } }))

// svgToPngDataUrl rasterizes via HTMLCanvasElement.getContext('2d'), which
// jsdom only implements when the optional `canvas` native package is
// installed (it isn't, here — see MermaidBlock.test.tsx's identical note
// about xterm's canvas/webgl addons). So only the paths that never reach the
// canvas — the no-diagram fast path, and the render-failure fallback — are
// covered without stubbing it; the successful path below stubs just enough
// of the canvas API to resolve.

describe('prerenderMermaidForExport', () => {
  it('returns markdown unchanged, and never touches mermaid, when there is no diagram', async () => {
    const markdown = '# Title\n\nJust some **text**, no fences here.\n'
    const result = await prerenderMermaidForExport(markdown)
    expect(result).toBe(markdown)
    expect(render_).not.toHaveBeenCalled()
  })

  it('leaves the original fence in place when mermaid fails to render it', async () => {
    render_.mockRejectedValueOnce(new Error('Parse error'))
    const markdown = 'Before.\n\n```mermaid\nnot a real diagram\n```\n\nAfter.'
    const result = await prerenderMermaidForExport(markdown)
    expect(result).toBe(markdown)
  })

  it('replaces each fence with its own rendered image and preserves surrounding text', async () => {
    render_.mockResolvedValueOnce({ svg: '<svg data-n="1"></svg>' })
    render_.mockRejectedValueOnce(new Error('second one fails'))

    const markdown =
      'Intro.\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nMiddle.\n\n```mermaid\nbroken\n```\n\nEnd.'

    const fakeCtx = { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,Zm9v')
    const originalImage = globalThis.Image
    class FakeImage {
      naturalWidth = 100
      naturalHeight = 50
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_v: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    // @ts-expect-error -- test stub, not a full Image implementation
    globalThis.Image = FakeImage

    try {
      const result = await prerenderMermaidForExport(markdown)
      expect(result).toBe(
        'Intro.\n\n![diagram](data:image/png;base64,Zm9v)\n\nMiddle.\n\n```mermaid\nbroken\n```\n\nEnd.',
      )
    } finally {
      globalThis.Image = originalImage
    }
  })
})
