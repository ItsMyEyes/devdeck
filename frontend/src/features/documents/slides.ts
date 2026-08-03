// Reads a .pptx into a per-slide outline: title, bulleted body text, tables,
// embedded images and speaker notes.
//
// Unlike the Word and Excel readers, this one does *not* try to reproduce the
// original layout. A faithful pptx renderer means implementing DrawingML
// geometry, theme inheritance and the slide-layout/master cascade — a project
// in itself. An outline is the honest, useful subset: it answers "what is in
// this deck" without pretending to be PowerPoint.

import {
  attr,
  children,
  descendants,
  firstChild,
  intAttr,
  isDisplayableImage,
  mediaMimeType,
  NS,
  OoxmlError,
  parseXml,
  readRelationships,
} from './ooxml'
import type { Relationship } from './ooxml'
import type { ZipArchive } from './zip'

const PRESENTATION_PART = 'ppt/presentation.xml'

const NOTES_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'

export interface SlideBullet {
  text: string
  /** 0-based outline indent from `a:pPr@lvl`. */
  level: number
}

export interface SlideImage {
  /** Object URL — owned by `Presentation.release()`. */
  url: string
  alt: string
}

export interface SlideTable {
  rows: string[][]
}

export interface Slide {
  /** 1-based position in the deck, as shown in PowerPoint. */
  number: number
  title: string
  bullets: SlideBullet[]
  tables: SlideTable[]
  images: SlideImage[]
  notes: string
}

export interface Presentation {
  slides: Slide[]
  release: () => void
}

export async function readPresentation(zip: ZipArchive): Promise<Presentation> {
  const bytes = await zip.readOptional(PRESENTATION_PART)
  if (!bytes) {
    throw new OoxmlError('This does not look like a PowerPoint file (no presentation part)')
  }

  const doc = parseXml(bytes, PRESENTATION_PART)
  const rels = await readRelationships(zip, PRESENTATION_PART)

  // `p:sldIdLst` is the authoritative slide *order*; the parts themselves are
  // named slide1.xml, slide2.xml… in creation order, which is not the same
  // thing once slides have been reordered.
  const parts: string[] = []
  for (const sldId of descendants(doc, NS.p, 'sldId')) {
    const relId = attr(sldId, NS.rel, 'id')
    const target = relId ? rels.get(relId)?.target : undefined
    if (target && zip.has(target)) parts.push(target)
  }

  if (parts.length === 0) {
    // Fall back to part naming for decks whose relationship graph we could not
    // follow — better a correct-ish outline than an error.
    const fallback = zip
      .namesUnder('ppt/slides/')
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort(bySlideNumber)
    parts.push(...fallback)
  }

  if (parts.length === 0) throw new OoxmlError('This presentation has no slides')

  const objectUrls: string[] = []
  const slides: Slide[] = []
  for (const [index, part] of parts.entries()) {
    slides.push(await readSlide(zip, part, index + 1, objectUrls))
  }

  return {
    slides,
    release: () => {
      for (const url of objectUrls) URL.revokeObjectURL(url)
      objectUrls.length = 0
    },
  }
}

function bySlideNumber(a: string, b: string): number {
  const number = (name: string) => Number.parseInt(/(\d+)\.xml$/.exec(name)?.[1] ?? '0', 10)
  return number(a) - number(b)
}

async function readSlide(
  zip: ZipArchive,
  part: string,
  number: number,
  objectUrls: string[],
): Promise<Slide> {
  const doc = parseXml(await zip.read(part), part)
  const rels = await readRelationships(zip, part)

  const spTree = firstChild(firstChild(doc.documentElement, NS.p, 'cSld'), NS.p, 'spTree')

  let title = ''
  const bullets: SlideBullet[] = []
  for (const sp of descendants(spTree, NS.p, 'sp')) {
    const placeholder = attr(
      firstChild(firstChild(firstChild(sp, NS.p, 'nvSpPr'), NS.p, 'nvPr'), NS.p, 'ph'),
      null,
      'type',
    )
    const paragraphs = readShapeParagraphs(firstChild(sp, NS.p, 'txBody'))
    if (paragraphs.length === 0) continue

    // The first title placeholder wins; a later one (rare, but decks do have
    // stray title boxes) is demoted to body text rather than overwriting it.
    if (!title && (placeholder === 'title' || placeholder === 'ctrTitle')) {
      title = paragraphs.map((p) => p.text).join(' ').trim()
      continue
    }
    bullets.push(...paragraphs)
  }

  const tables: SlideTable[] = []
  for (const tbl of descendants(spTree, NS.a, 'tbl')) {
    const rows: string[][] = []
    for (const tr of children(tbl, NS.a, 'tr')) {
      rows.push(
        children(tr, NS.a, 'tc').map((tc) =>
          readShapeParagraphs(firstChild(tc, NS.a, 'txBody'))
            .map((p) => p.text)
            .join(' ')
            .trim(),
        ),
      )
    }
    if (rows.length > 0) tables.push({ rows })
  }

  const images = await readSlideImages(zip, spTree, rels, objectUrls)
  const notes = await readNotes(zip, rels)

  return { number, title, bullets, tables, images, notes }
}

/**
 * `a:p` paragraphs of a text body, flattened to text + indent level. Empty
 * paragraphs are dropped: PowerPoint uses them as vertical spacers, and they
 * would render as blank bullets.
 */
function readShapeParagraphs(txBody: Element | null): SlideBullet[] {
  if (!txBody) return []

  const out: SlideBullet[] = []
  for (const p of children(txBody, NS.a, 'p')) {
    const level = intAttr(firstChild(p, NS.a, 'pPr'), null, 'lvl') ?? 0

    let text = ''
    for (const el of Array.from(p.children)) {
      if (el.namespaceURI !== NS.a) continue
      if (el.localName === 'r') {
        // `a:fld` (slide number, date) also holds an a:t, but it is chrome
        // rather than content — only real runs are collected here.
        text += firstChild(el, NS.a, 't')?.textContent ?? ''
      } else if (el.localName === 'br') {
        text += '\n'
      }
    }

    const trimmed = text.trim()
    if (trimmed) out.push({ text: trimmed, level: Math.max(0, level) })
  }
  return out
}

async function readSlideImages(
  zip: ZipArchive,
  spTree: Element | null,
  rels: Map<string, Relationship>,
  objectUrls: string[],
): Promise<SlideImage[]> {
  const images: SlideImage[] = []
  const seen = new Set<string>()

  for (const pic of descendants(spTree, NS.p, 'pic')) {
    const relId = attr(firstDescendantBlip(pic), NS.rel, 'embed')
    if (!relId || seen.has(relId)) continue
    seen.add(relId)

    const rel = rels.get(relId)
    if (!rel || rel.external || !isDisplayableImage(rel.target) || !zip.has(rel.target)) continue

    const cNvPr = firstChild(firstChild(pic, NS.p, 'nvPicPr'), NS.p, 'cNvPr')
    const alt = attr(cNvPr, null, 'descr') || attr(cNvPr, null, 'name') || 'Slide image'

    const data = await zip.read(rel.target)
    const url = URL.createObjectURL(new Blob([data.slice()], { type: mediaMimeType(rel.target) }))
    objectUrls.push(url)
    images.push({ url, alt })
  }
  return images
}

function firstDescendantBlip(pic: Element): Element | null {
  return pic.getElementsByTagNameNS(NS.a, 'blip')[0] ?? null
}

async function readNotes(zip: ZipArchive, rels: Map<string, Relationship>): Promise<string> {
  const notesRel = [...rels.values()].find((rel) => rel.type === NOTES_REL_TYPE)
  if (!notesRel || !zip.has(notesRel.target)) return ''

  let doc: Document
  try {
    doc = parseXml(await zip.read(notesRel.target), notesRel.target)
  } catch {
    return ''
  }

  // The notes part repeats the slide's own text in a `sldImg`-linked
  // placeholder; only the `body` placeholder holds what the presenter typed.
  const lines: string[] = []
  for (const sp of descendants(doc, NS.p, 'sp')) {
    const placeholderType = attr(
      firstChild(firstChild(firstChild(sp, NS.p, 'nvSpPr'), NS.p, 'nvPr'), NS.p, 'ph'),
      null,
      'type',
    )
    if (placeholderType !== 'body') continue
    for (const paragraph of readShapeParagraphs(firstChild(sp, NS.p, 'txBody'))) {
      lines.push(paragraph.text)
    }
  }
  return lines.join('\n').trim()
}

/** Exported for the outline header: total text length, to spot empty decks. */
export function slideIsEmpty(slide: Slide): boolean {
  return (
    !slide.title &&
    slide.bullets.length === 0 &&
    slide.tables.length === 0 &&
    slide.images.length === 0
  )
}
