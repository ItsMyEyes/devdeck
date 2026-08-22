import { useEffect, useMemo, useState } from 'react'
import { FileWarning, Maximize2, Minimize2 } from 'lucide-react'
import { fmtBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Images and video, rendered from the raw bytes the document tab already
 * downloads.
 *
 * Before this these formats had no viewer at all: neither is UTF-8, so opening
 * one fell through to the text editor and died on
 * `WorktreeFileService.Read`'s "%q is not a UTF-8 text file" — the same dead
 * end `documentKind.ts` was written to route Office formats around.
 *
 * A blob URL rather than a data URL: `<video>` needs to seek, and a base64
 * data URL is both un-seekable in practice and ~33% larger in memory for a
 * file that is already the biggest thing this tab will ever hold.
 */
export function MediaView({
  bytes,
  mime,
  kind,
  name,
}: {
  bytes: Uint8Array
  mime: string
  kind: 'image' | 'video'
  name: string
}) {
  const url = useObjectURL(bytes, mime)
  const [failed, setFailed] = useState(false)
  // Images open fitted to the pane, which is what you want for a screenshot;
  // actual size is one click away for the times you need to read pixels.
  const [actualSize, setActualSize] = useState(false)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)

  // A new file in the same tab is a new blob: forget the previous one's error
  // and dimensions, or a broken image would poison the next one.
  useEffect(() => {
    setFailed(false)
    setNatural(null)
  }, [url])

  if (!url || failed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-devdeck-pane px-6 text-center">
        <FileWarning size={22} className="text-devdeck-yellow" />
        <span className="max-w-lg font-mono text-[11px] leading-relaxed text-devdeck-fg-2">
          {kind === 'video'
            ? `This browser cannot decode ${name}. Download it to play it in a media player.`
            : `${name} could not be decoded as an image. It may be corrupt, or not really a ${name.split('.').pop()?.toUpperCase()} file.`}
        </span>
      </div>
    )
  }

  if (kind === 'video') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-devdeck-base p-4">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a file preview has no caption track */}
        <video
          src={url}
          controls
          className="max-h-full max-w-full rounded"
          onError={() => setFailed(true)}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-devdeck-base">
      <div
        className={cn(
          'flex min-h-0 flex-1 p-4',
          actualSize ? 'overflow-auto' : 'items-center justify-center overflow-hidden',
        )}
      >
        <img
          src={url}
          alt={name}
          onLoad={(event) =>
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={() => setFailed(true)}
          className={cn(
            // The checkerboard is what makes a transparent PNG readable —
            // without it an all-white logo is invisible in dark mode and an
            // all-black one is invisible in light.
            'devdeck-alpha-checkerboard rounded',
            actualSize ? 'max-w-none' : 'max-h-full max-w-full object-contain',
          )}
        />
      </div>
      <div className="flex flex-none items-center gap-3 border-t border-devdeck-border bg-devdeck-pane px-3 py-1.5">
        <span className="font-mono text-[10px] text-devdeck-fg-2">
          {natural ? `${natural.width} x ${natural.height}` : '—'} · {fmtBytes(bytes.byteLength)}
        </span>
        <button
          type="button"
          onClick={() => setActualSize((current) => !current)}
          className="ml-auto flex cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[10px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
        >
          {actualSize ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          {actualSize ? 'Fit to pane' : 'Actual size'}
        </button>
      </div>
    </div>
  )
}

/**
 * A blob URL for these bytes, revoked when they change or the tab unmounts.
 *
 * The revoke is the whole reason this is a hook: a blob URL pins its bytes in
 * the process for as long as it is alive, so leaking one per file opened turns
 * an afternoon of browsing screenshots into hundreds of megabytes that no
 * garbage collector can reclaim.
 */
function useObjectURL(bytes: Uint8Array, mime: string): string {
  const blob = useMemo(
    // `slice()` copies out of the possibly-larger ArrayBuffer this view sits
    // on, so Blob never captures more than this file's bytes.
    () => new Blob([bytes.slice().buffer as ArrayBuffer], mime ? { type: mime } : undefined),
    [bytes, mime],
  )
  const [url, setUrl] = useState('')
  useEffect(() => {
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => {
      URL.revokeObjectURL(next)
      setUrl('')
    }
  }, [blob])
  return url
}
