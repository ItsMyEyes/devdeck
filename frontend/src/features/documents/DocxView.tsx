import { Fragment } from 'react'
import { cn } from '@/lib/utils'
import { readDocx, paragraphText } from './docx'
import type { DocxBlock, DocxDocument, DocxParagraph, DocxRun } from './docx'
import { DocumentParseState } from './DocumentParseState'
import { useAsyncParse } from './useAsyncParse'
import { readZip } from './zip'

const parse = async (bytes: Uint8Array): Promise<DocxDocument> => readDocx(readZip(bytes))
const release = (doc: DocxDocument) => doc.release()

export function DocxView({ bytes }: { bytes: Uint8Array }) {
  const state = useAsyncParse(bytes, parse, release)
  if (state.status !== 'ready' || !state.data) {
    return <DocumentParseState state={state} label="Reading document…" />
  }

  const { blocks } = state.data
  if (blocks.length === 0) {
    return <DocumentParseState state={{ status: 'ready' }} emptyLabel="This document is empty" />
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-devdeck-terminal px-8 py-8">
      {/* A fixed reading measure — a document body stretched across an
          ultrawide pane is unreadable, and this is a reading surface. */}
      <div className="mx-auto flex max-w-3xl flex-col gap-3 text-[13px] leading-relaxed text-devdeck-fg-2">
        {groupIntoLists(blocks).map((item, index) =>
          item.kind === 'list' ? (
            <ListBlock key={index} paragraphs={item.paragraphs} ordered={item.ordered} />
          ) : item.kind === 'table' ? (
            <TableBlock key={index} rows={item.rows} />
          ) : (
            <ParagraphBlock key={index} paragraph={item.paragraph} />
          ),
        )}
      </div>
    </div>
  )
}

// ---- Rendering ----

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-4 text-[20px] font-semibold text-devdeck-fg',
  2: 'mt-4 text-[17px] font-semibold text-devdeck-fg',
  3: 'mt-3 text-[15px] font-semibold text-devdeck-fg',
  4: 'mt-3 text-[13.5px] font-semibold text-devdeck-fg',
  5: 'mt-2 text-[13px] font-semibold text-devdeck-fg-2',
  6: 'mt-2 text-[12.5px] font-semibold uppercase tracking-wide text-devdeck-muted',
}

function ParagraphBlock({ paragraph }: { paragraph: DocxParagraph }) {
  const hasText = paragraphText(paragraph).trim().length > 0

  return (
    <>
      {hasText ? (
        <p className={cn(paragraph.heading > 0 && HEADING_CLASS[paragraph.heading])}>
          <Runs runs={paragraph.runs} />
        </p>
      ) : null}
      {paragraph.images.map((image, index) => (
        <img
          key={index}
          src={image.url}
          alt={image.alt}
          className="my-2 max-w-full self-start rounded border border-devdeck-border"
        />
      ))}
    </>
  )
}

function Runs({ runs }: { runs: DocxRun[] }) {
  return (
    <>
      {runs.map((run, index) => {
        // `w:br` becomes "\n" in the run text; preserve those as real breaks
        // without turning the whole paragraph into `whitespace-pre` (which
        // would also freeze the soft wrapping we want).
        const lines = run.text.split('\n')
        const content = lines.map((line, lineIndex) => (
          <Fragment key={lineIndex}>
            {lineIndex > 0 ? <br /> : null}
            {line}
          </Fragment>
        ))

        const className = cn(
          run.bold && 'font-semibold text-devdeck-fg',
          run.italic && 'italic',
          run.underline && 'underline underline-offset-2',
        )

        if (run.href) {
          return (
            <a
              key={index}
              href={run.href}
              target="_blank"
              rel="noreferrer"
              className={cn(className, 'text-devdeck-accent-soft underline underline-offset-2')}
            >
              {content}
            </a>
          )
        }
        return (
          <span key={index} className={className || undefined}>
            {content}
          </span>
        )
      })}
    </>
  )
}

function ListBlock({ paragraphs, ordered }: { paragraphs: DocxParagraph[]; ordered: boolean }) {
  const ListTag = ordered ? 'ol' : 'ul'
  return (
    <ListTag className={cn('flex flex-col gap-1', ordered ? 'list-decimal' : 'list-disc')}>
      {paragraphs.map((paragraph, index) => (
        <li
          key={index}
          // Word nests lists by indent level rather than by nesting elements,
          // so indent is reproduced with padding instead of nested <ul>s.
          style={{ marginLeft: `${1.25 + Math.max(0, paragraph.listLevel) * 1.25}rem` }}
          className="pl-1"
        >
          <Runs runs={paragraph.runs} />
        </li>
      ))}
    </ListTag>
  )
}

function TableBlock({ rows }: { rows: DocxParagraph[][][] }) {
  if (rows.length === 0) return null
  return (
    <div className="my-2 overflow-x-auto rounded border border-devdeck-border">
      <table className="w-full border-collapse text-[12px]">
        <tbody>
          {rows.map((cells, rowIndex) => (
            <tr key={rowIndex} className={rowIndex === 0 ? 'bg-devdeck-surface-2' : undefined}>
              {cells.map((paragraphs, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cn(
                    'border border-devdeck-border px-2.5 py-1.5 align-top',
                    rowIndex === 0 && 'font-semibold text-devdeck-fg',
                  )}
                >
                  {paragraphs.map((paragraph, index) => (
                    <div key={index}>
                      <Runs runs={paragraph.runs} />
                    </div>
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---- List grouping ----

type RenderItem =
  | { kind: 'paragraph'; paragraph: DocxParagraph }
  | { kind: 'list'; paragraphs: DocxParagraph[]; ordered: boolean }
  | { kind: 'table'; rows: DocxParagraph[][][] }

/**
 * Word has no list *element* — consecutive paragraphs simply share a numbering
 * reference. Rebuilding the run of them into one `<ul>`/`<ol>` is what makes
 * an ordered list actually count 1, 2, 3 instead of restarting at every item.
 */
export function groupIntoLists(blocks: DocxBlock[]): RenderItem[] {
  const items: RenderItem[] = []

  for (const block of blocks) {
    if (block.kind === 'table') {
      items.push({ kind: 'table', rows: block.rows })
      continue
    }
    if (block.listLevel < 0) {
      items.push({ kind: 'paragraph', paragraph: block })
      continue
    }

    const previous = items[items.length - 1]
    if (previous?.kind === 'list' && previous.ordered === block.ordered) {
      previous.paragraphs.push(block)
    } else {
      items.push({ kind: 'list', paragraphs: [block], ordered: block.ordered })
    }
  }
  return items
}
