/**
 * Downscale + re-encode composer image attachments that are too big for
 * upload, before they leave the browser. Ported from t3code's ladder
 * (`gg/t3code/apps/web/src/lib/imageCompression.ts`, reference only — not
 * imported) but scoped down to this feature's own need: a single
 * `File -> File` transform for the composer's upload-on-add path, not a
 * localStorage-stash budget.
 */

/**
 * Longest edge kept when an image needs to be downscaled. Sized so a
 * typical retina screenshot stays legible rather than being halved.
 */
export const MAX_DIMENSION = 2048

/**
 * Ceiling on the *source* file handed to the decoder. File size is a proxy
 * for pixel count, and decoding hundreds of megapixels into an ImageBitmap
 * can OOM the tab — above this the file is refused outright, before any
 * decode is attempted.
 */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024

/**
 * Target output size the ladder tries to hit. The backend's attachment
 * upload route enforces a 10MB cap per image (composer-context-attachments
 * design, "C1 — handler"); downscaling toward the same number means a paste
 * that would otherwise be rejected server-side usually just uploads.
 */
export const TARGET_MAX_BYTES = 10 * 1024 * 1024

/**
 * Quality ladder tried, in order, until the encoded image fits
 * `TARGET_MAX_BYTES`. The floor stays high enough to avoid visible blocking
 * on UI screenshots; if even that overflows, resolution drops instead.
 */
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const

/** Extra downscale passes applied when even the lowest quality overflows. */
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const

interface Canvas2D {
  canvas: OffscreenCanvas | HTMLCanvasElement
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
}

function createCanvas(width: number, height: number): Canvas2D | null {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) return null
    return { canvas, context }
  }
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  return { canvas, context }
}

function canvasToBlob(canvas: OffscreenCanvas | HTMLCanvasElement, quality: number): Promise<Blob | null> {
  if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  }
  return (canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality })
}

/**
 * Re-encoding always lands as JPEG (the quality ladder has no effect on a
 * lossless container), so a name like `shot.png` would lie about its
 * contents. Swap the extension to match.
 */
function jpegFileName(name: string): string {
  const dotIndex = name.lastIndexOf('.')
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name || 'image'
  return `${base}.jpg`
}

/**
 * Draws `bitmap` scaled to fit `targetDimension`, then walks the quality
 * ladder against that single canvas, stopping at the first encoding that
 * fits `TARGET_MAX_BYTES`. Returns the smallest encoding produced even if
 * every step still overflows, so the caller can fall back to a smaller
 * scale pass instead of giving up outright.
 */
async function encodeWithinTarget(bitmap: ImageBitmap, targetDimension: number, name: string): Promise<File | null> {
  const scale = targetDimension / Math.max(bitmap.width, bitmap.height)
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const target = createCanvas(width, height)
  if (!target) return null

  // JPEG has no alpha channel; matte transparent regions white before
  // drawing so they don't turn black.
  target.context.fillStyle = '#ffffff'
  target.context.fillRect(0, 0, width, height)
  target.context.drawImage(bitmap, 0, 0, width, height)

  let smallest: File | null = null
  for (const quality of QUALITY_STEPS) {
    const blob = await canvasToBlob(target.canvas, quality)
    if (!blob) continue
    const candidate = new File([blob], jpegFileName(name), { type: 'image/jpeg' })
    if (smallest === null || candidate.size < smallest.size) {
      smallest = candidate
    }
    if (candidate.size <= TARGET_MAX_BYTES) {
      return candidate
    }
  }
  return smallest
}

/**
 * Downscales and re-encodes `file` so it fits within `MAX_DIMENSION` and
 * `TARGET_MAX_BYTES`. A file already within both thresholds passes through
 * unchanged — no decode-and-redraw for something that doesn't need it.
 * Rejects (never silently truncates) sources above `MAX_SOURCE_BYTES`:
 * decoding hundreds of megapixels into an `ImageBitmap` is the risk, so no
 * amount of downscaling makes it safe.
 */
export async function downscaleImage(file: File): Promise<File> {
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`image exceeds the ${MAX_SOURCE_BYTES}-byte source cap`)
  }

  const bitmap = await createImageBitmap(file)
  try {
    const longestEdge = Math.max(bitmap.width, bitmap.height)
    if (longestEdge <= MAX_DIMENSION && file.size <= TARGET_MAX_BYTES) {
      return file
    }

    // Each fallback pass shrinks relative to the *already-capped* base
    // dimension, not the raw source — scaling a fixed 2048 ceiling would be
    // a no-op for images already smaller than that ceiling, and the
    // fallback passes would never actually reduce resolution below it.
    const baseDimension = Math.min(MAX_DIMENSION, longestEdge)
    let smallest: File | null = null
    for (const scale of [1, ...FALLBACK_SCALE_STEPS]) {
      const targetDimension = Math.max(1, Math.round(baseDimension * scale))
      const encoded = await encodeWithinTarget(bitmap, targetDimension, file.name)
      if (!encoded) continue
      if (smallest === null || encoded.size < smallest.size) {
        smallest = encoded
      }
      if (encoded.size <= TARGET_MAX_BYTES) {
        return encoded
      }
    }
    return smallest ?? file
  } finally {
    bitmap.close()
  }
}
