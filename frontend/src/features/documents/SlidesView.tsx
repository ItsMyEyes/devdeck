import { StickyNote } from 'lucide-react'
import { cn } from '@/lib/utils'
import { readPresentation, slideIsEmpty } from './slides'
import type { Presentation, Slide } from './slides'
import { DocumentParseState } from './DocumentParseState'
import { useAsyncParse } from './useAsyncParse'
import { readZip } from './zip'

const parse = async (bytes: Uint8Array): Promise<Presentation> => readPresentation(readZip(bytes))
const release = (deck: Presentation) => deck.release()

export function SlidesView({ bytes }: { bytes: Uint8Array }) {
  const state = useAsyncParse(bytes, parse, release)
  if (state.status !== 'ready' || !state.data) {
    return <DocumentParseState state={state} label="Reading presentation…" />
  }

  const { slides } = state.data
  if (slides.length === 0) {
    return <DocumentParseState state={{ status: 'ready' }} emptyLabel="This deck has no slides" />
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-devdeck-pane px-6 py-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        {slides.map((slide) => (
          <SlideCard key={slide.number} slide={slide} total={slides.length} />
        ))}
      </div>
    </div>
  )
}

function SlideCard({ slide, total }: { slide: Slide; total: number }) {
  return (
    <section className="overflow-hidden rounded border border-devdeck-border bg-devdeck-pane">
      <header className="flex items-baseline gap-3 border-b border-devdeck-border bg-devdeck-card-wash px-4 py-2">
        <span className="flex-none font-mono text-[10px] text-devdeck-fg-2">
          {slide.number} / {total}
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-devdeck-fg">
          {slide.title || <span className="text-devdeck-fg-2 italic">Untitled slide</span>}
        </h2>
      </header>

      <div className="flex flex-col gap-3 px-5 py-4">
        {slideIsEmpty(slide) ? (
          <span className="font-mono text-[11px] text-devdeck-fg-2">
            No text on this slide - it may be image- or chart-only.
          </span>
        ) : null}

        {slide.bullets.length > 0 ? (
          <ul className="flex flex-col gap-1 text-[12.5px] leading-relaxed text-devdeck-fg-2">
            {slide.bullets.map((bullet, index) => (
              <li
                key={index}
                // PowerPoint's outline levels are an indent, not nesting —
                // mirrored here with a margin rather than nested lists.
                style={{ marginLeft: `${bullet.level * 1.15}rem` }}
                className="flex gap-2"
              >
                <span aria-hidden className="flex-none text-devdeck-fg-2">
                  {bullet.level === 0 ? '•' : '◦'}
                </span>
                <span className="min-w-0 whitespace-pre-wrap">{bullet.text}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {slide.tables.map((table, tableIndex) => (
          <div
            key={tableIndex}
            className="overflow-x-auto rounded border border-devdeck-border"
          >
            <table className="w-full border-collapse text-[11.5px]">
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className={rowIndex === 0 ? 'bg-devdeck-card-wash' : undefined}>
                    {row.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        className={cn(
                          'border border-devdeck-border px-2 py-1 align-top text-devdeck-fg-2',
                          rowIndex === 0 && 'font-semibold text-devdeck-fg',
                        )}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        {slide.images.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {slide.images.map((image, index) => (
              <img
                key={index}
                src={image.url}
                alt={image.alt}
                className="max-h-64 max-w-full rounded border border-devdeck-border object-contain"
              />
            ))}
          </div>
        ) : null}

        {slide.notes ? (
          <div className="flex gap-2 rounded border border-devdeck-border bg-devdeck-pane px-3 py-2">
            <StickyNote size={13} className="mt-0.5 flex-none text-devdeck-fg-2" />
            <p className="min-w-0 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-devdeck-fg-2">
              {slide.notes}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  )
}
