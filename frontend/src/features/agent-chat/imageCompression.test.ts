import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_DIMENSION,
  MAX_SOURCE_BYTES,
  TARGET_MAX_BYTES,
  downscaleImage,
} from '@/features/agent-chat/imageCompression'

/**
 * jsdom has no real canvas/codec, so the re-encode path is exercised with a
 * stubbed `createImageBitmap` + `OffscreenCanvas`. This repo has no existing
 * canvas-mocked test to follow as precedent (see plan T9), so the stub is
 * built from scratch here: it fakes a decoded bitmap of a given pixel size
 * and an encoder whose output byte size is controlled per-test, mirroring
 * how a real JPEG encoder shrinks as quality drops or the canvas shrinks —
 * enough to pin the ladder's *order* and *stopping conditions*, not pixels.
 */

const originalCreateImageBitmap = globalThis.createImageBitmap
const originalOffscreenCanvas = globalThis.OffscreenCanvas

function makeFile(sizeBytes: number, name = 'shot.png', type = 'image/png'): File {
  return new File([new Uint8Array(sizeBytes)], name, { type })
}

/** Stubs `createImageBitmap` to resolve a fake bitmap of the given pixel size. */
function stubDecoder(width: number, height: number) {
  const close = vi.fn()
  const decode = vi.fn(async () => ({ width, height, close }))
  vi.stubGlobal('createImageBitmap', decode)
  return { decode, close }
}

/**
 * Stubs `OffscreenCanvas` so every `convertToBlob({ quality })` call resolves
 * a blob whose size comes from `sizeForQuality`. One canvas is constructed
 * per downscale *pass* (matching the real implementation drawing once and
 * re-encoding at each quality step against that same canvas).
 */
function stubCanvas(sizeForQuality: (quality: number) => number) {
  const fillRect = vi.fn()
  const drawImage = vi.fn()
  const constructedWidths: number[] = []
  const qualitiesRequested: number[] = []
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      width: number
      height: number
      constructor(width: number, height: number) {
        this.width = width
        this.height = height
        constructedWidths.push(width)
      }
      getContext() {
        return { fillStyle: '', fillRect, drawImage }
      }
      async convertToBlob({ quality }: { type: string; quality: number }) {
        qualitiesRequested.push(quality)
        return new Blob([new Uint8Array(sizeForQuality(quality))], { type: 'image/jpeg' })
      }
    },
  )
  return { fillRect, drawImage, constructedWidths, qualitiesRequested }
}

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.createImageBitmap = originalCreateImageBitmap
  globalThis.OffscreenCanvas = originalOffscreenCanvas
})

describe('downscaleImage', () => {
  it('rejects a source file over the 50MB cap before any decode is attempted', async () => {
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)

    await expect(downscaleImage(makeFile(MAX_SOURCE_BYTES + 1))).rejects.toThrow()
    expect(decode).not.toHaveBeenCalled()
  })

  it('passes a file already under every threshold through unchanged', async () => {
    stubDecoder(1200, 900)
    const canvas = stubCanvas(() => 1_000_000)
    const original = makeFile(2048, 'shot.png')

    const result = await downscaleImage(original)

    expect(result).toBe(original)
    expect(canvas.drawImage).not.toHaveBeenCalled()
  })

  it('downscales an image whose longest edge exceeds 2048px, stepping down the quality ladder in order and stopping at the first fit', async () => {
    stubDecoder(4000, 3000)
    // Only the third quality step (0.78) produces a small enough blob.
    const canvas = stubCanvas((quality) => (quality <= 0.78 ? 400_000 : 20 * 1024 * 1024))
    const original = makeFile(12 * 1024 * 1024, 'shot.png')

    const result = await downscaleImage(original)

    expect(result).not.toBe(original)
    expect(result.type).toBe('image/jpeg')
    expect(result.size).toBeLessThanOrEqual(TARGET_MAX_BYTES)
    // Stops as soon as 0.78 fits — never tries 0.68.
    expect(canvas.qualitiesRequested).toEqual([0.92, 0.85, 0.78])
    // The first (only) canvas pass is capped at the 2048px ceiling.
    expect(canvas.constructedWidths).toEqual([MAX_DIMENSION])
  })

  it('falls through to the fallback scale-reduction steps once the quality ladder is exhausted', async () => {
    stubDecoder(4000, 3000)
    // Every quality step at the full 2048px ceiling is too big; only a
    // reduced-scale pass (a narrower requested canvas width) fits the
    // target, regardless of quality.
    let smallestWidthSoFar = Number.POSITIVE_INFINITY
    const drawImage = vi.fn()
    const constructedWidths: number[] = []
    const qualitiesRequested: number[] = []
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        width: number
        height: number
        constructor(width: number, height: number) {
          this.width = width
          this.height = height
          constructedWidths.push(width)
          smallestWidthSoFar = Math.min(smallestWidthSoFar, width)
        }
        getContext() {
          return { fillStyle: '', fillRect: vi.fn(), drawImage }
        }
        async convertToBlob({ quality }: { type: string; quality: number }) {
          qualitiesRequested.push(quality)
          const size = smallestWidthSoFar < MAX_DIMENSION ? 2 * 1024 * 1024 : 20 * 1024 * 1024
          return new Blob([new Uint8Array(size)], { type: 'image/jpeg' })
        }
      },
    )
    const original = makeFile(20 * 1024 * 1024, 'shot.png')

    const result = await downscaleImage(original)

    expect(result.size).toBeLessThanOrEqual(TARGET_MAX_BYTES)
    // The full 2048px pass ran through all four quality steps before the
    // implementation moved on to a reduced scale.
    expect(qualitiesRequested.slice(0, 4)).toEqual([0.92, 0.85, 0.78, 0.68])
    expect(constructedWidths[0]).toBe(MAX_DIMENSION)
    expect(constructedWidths.some((width) => width < MAX_DIMENSION)).toBe(true)
  })
})
