// Reads a .docx into a flat block model the React view can render directly.
//
// This is a *viewer*, not a fidelity-perfect renderer: it reproduces reading
// order, headings, lists, tables, inline emphasis, hyperlinks and images —
// the things you open a document to read. Page geometry, columns, fonts,
// colours, footnotes and revision marks are deliberately dropped.

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
  toggleValue,
} from './ooxml'
import type { Relationship } from './ooxml'
import type { ZipArchive } from './zip'

const DOCUMENT_PART = 'word/document.xml'
const NUMBERING_PART = 'word/numbering.xml'
const STYLES_PART = 'word/styles.xml'

export interface DocxRun {
  text: string
  bold: boolean
  italic: boolean
  underline: boolean
  /** Present when the run sits inside a `w:hyperlink` with an external target. */
  href?: string
}

export interface DocxImage {
  /** Object URL for the embedded media — owned by `DocxDocument.release()`. */
  url: string
  alt: string
}

export interface DocxParagraph {
  kind: 'paragraph'
  runs: DocxRun[]
  /** 1–6 for Heading1–6 and Title, 0 for body text. */
  heading: number
  /** 0-based list indent, or -1 when the paragraph is not a list item. */
  listLevel: number
  ordered: boolean
  images: DocxImage[]
}

export interface DocxTable {
  kind: 'table'
  /** rows → cells → the paragraphs inside that cell. */
  rows: DocxParagraph[][][]
}

export type DocxBlock = DocxParagraph | DocxTable

export interface DocxDocument {
  blocks: DocxBlock[]
  /** Revokes every object URL handed out in `images`. Call on unmount. */
  release: () => void
}

export async function readDocx(zip: ZipArchive): Promise<DocxDocument> {
  const bytes = await zip.readOptional(DOCUMENT_PART)
  if (!bytes) {
    throw new OoxmlError('This does not look like a Word document (no document part)')
  }

  const doc = parseXml(bytes, DOCUMENT_PART)
  const rels = await readRelationships(zip, DOCUMENT_PART)
  const numbering = await readNumbering(zip)
  const styles = await readStyles(zip)

  const objectUrls: string[] = []
  const mediaCache = new Map<string, DocxImage | null>()

  // Images are resolved eagerly (the parse is already async and the media is
  // in the same archive), so the React view stays synchronous.
  const imageFor = async (relId: string, alt: string): Promise<DocxImage | null> => {
    const cached = mediaCache.get(relId)
    if (cached !== undefined) return cached ? { ...cached, alt: alt || cached.alt } : null

    const rel = rels.get(relId)
    if (!rel || rel.external || !isDisplayableImage(rel.target) || !zip.has(rel.target)) {
      mediaCache.set(relId, null)
      return null
    }
    const data = await zip.read(rel.target)
    // Copy out of the archive's buffer: `read` returns a subarray view for
    // stored entries, and Blob would otherwise capture the whole file.
    const url = URL.createObjectURL(new Blob([data.slice()], { type: mediaMimeType(rel.target) }))
    objectUrls.push(url)
    const image: DocxImage = { url, alt }
    mediaCache.set(relId, image)
    return image
  }

  const body = firstChild(doc.documentElement, NS.w, 'body')
  if (!body) throw new OoxmlError('This Word document has no body')

  const blocks: DocxBlock[] = []
  for (const el of Array.from(body.children)) {
    if (el.namespaceURI !== NS.w) continue
    if (el.localName === 'p') {
      blocks.push(await readParagraph(el, rels, numbering, styles, imageFor))
    } else if (el.localName === 'tbl') {
      blocks.push(await readTable(el, rels, numbering, styles, imageFor))
    }
  }

  return {
    blocks,
    release: () => {
      for (const url of objectUrls) URL.revokeObjectURL(url)
      objectUrls.length = 0
    },
  }
}

type ImageResolver = (relId: string, alt: string) => Promise<DocxImage | null>

async function readTable(
  tbl: Element,
  rels: Map<string, Relationship>,
  numbering: NumberingMap,
  styles: StyleMap,
  imageFor: ImageResolver,
): Promise<DocxTable> {
  const rows: DocxParagraph[][][] = []
  for (const tr of children(tbl, NS.w, 'tr')) {
    const cells: DocxParagraph[][] = []
    for (const tc of children(tr, NS.w, 'tc')) {
      const paragraphs: DocxParagraph[] = []
      for (const p of children(tc, NS.w, 'p')) {
        paragraphs.push(await readParagraph(p, rels, numbering, styles, imageFor))
      }
      cells.push(paragraphs)
    }
    rows.push(cells)
  }
  return { kind: 'table', rows }
}

async function readParagraph(
  p: Element,
  rels: Map<string, Relationship>,
  numbering: NumberingMap,
  styles: StyleMap,
  imageFor: ImageResolver,
): Promise<DocxParagraph> {
  const pPr = firstChild(p, NS.w, 'pPr')
  const styleId = attr(firstChild(pPr, NS.w, 'pStyle'), NS.w, 'val') ?? ''

  const list = resolveListMembership(pPr, styleId, styles)
  const listLevel = list ? list.level : -1
  const ordered = list !== null && isOrderedList(numbering, list.numId, list.level)

  const runs: DocxRun[] = []
  const images: DocxImage[] = []

  // Runs can sit directly in the paragraph or nested inside a w:hyperlink,
  // and both orders matter for reading order — so walk children in sequence
  // rather than collecting all w:r descendants at once.
  for (const el of Array.from(p.children)) {
    if (el.namespaceURI !== NS.w) continue
    if (el.localName === 'r') {
      await collectRun(el, undefined, runs, images, imageFor)
    } else if (el.localName === 'hyperlink') {
      const relId = attr(el, NS.rel, 'id')
      const rel = relId ? rels.get(relId) : undefined
      const href = rel?.external ? rel.target : undefined
      for (const r of children(el, NS.w, 'r')) {
        await collectRun(r, href, runs, images, imageFor)
      }
    }
  }

  return {
    kind: 'paragraph',
    runs: mergeRuns(runs),
    heading: headingLevelFor(styleId),
    listLevel,
    ordered,
    images,
  }
}

async function collectRun(
  r: Element,
  href: string | undefined,
  runs: DocxRun[],
  images: DocxImage[],
  imageFor: ImageResolver,
): Promise<void> {
  const rPr = firstChild(r, NS.w, 'rPr')
  const bold = toggleValue(firstChild(rPr, NS.w, 'b'))
  const italic = toggleValue(firstChild(rPr, NS.w, 'i'))
  // w:u carries a *style* (single/dotted/none), not a toggle — "none" is the
  // one value that means not underlined.
  const underlineStyle = attr(firstChild(rPr, NS.w, 'u'), NS.w, 'val')
  const underline = underlineStyle !== null && underlineStyle !== 'none'

  let text = ''
  for (const el of Array.from(r.children)) {
    // Run children that matter are all in the `w` namespace — including
    // `w:drawing`, whose *contents* are DrawingML but whose wrapper is not.
    if (el.namespaceURI !== NS.w) continue
    switch (el.localName) {
      case 't':
        text += el.textContent ?? ''
        break
      case 'tab':
        text += '\t'
        break
      case 'br':
      case 'cr':
        text += '\n'
        break
      case 'noBreakHyphen':
        text += '-'
        break
      case 'drawing':
      case 'pict': {
        const image = await readDrawing(el, imageFor)
        if (image) images.push(image)
        break
      }
      default:
        break
    }
  }

  if (text) runs.push({ text, bold, italic, underline, ...(href ? { href } : {}) })
}

async function readDrawing(el: Element, imageFor: ImageResolver): Promise<DocxImage | null> {
  // Modern DrawingML (`w:drawing` → `a:blip r:embed`), falling back to the
  // legacy VML shape (`w:pict` → `v:imagedata r:id`) that Word still emits
  // for pasted screenshots and documents saved from older versions.
  const blip = el.getElementsByTagNameNS(NS.a, 'blip')[0]
  let relId = attr(blip ?? null, NS.rel, 'embed')
  if (!relId) {
    const imagedata = Array.from(el.getElementsByTagName('*')).find(
      (node) => node.localName === 'imagedata',
    )
    relId = attr(imagedata ?? null, NS.rel, 'id')
  }
  if (!relId) return null
  // The alt text lives on wp:docPr, in the drawing-wordprocessing namespace —
  // matched by local name since that namespace is not otherwise needed here.
  const docPr = Array.from(el.getElementsByTagName('*')).find((node) => node.localName === 'docPr')
  const alt = docPr?.getAttribute('descr') || docPr?.getAttribute('name') || 'Embedded image'
  return imageFor(relId, alt)
}

/**
 * Collapses adjacent runs that share formatting. Word splits a single styled
 * sentence across many runs (spell-check state, rsid tracking, language
 * marks), which would otherwise render as dozens of `<span>`s per line.
 */
function mergeRuns(runs: DocxRun[]): DocxRun[] {
  const merged: DocxRun[] = []
  for (const run of runs) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      previous.bold === run.bold &&
      previous.italic === run.italic &&
      previous.underline === run.underline &&
      previous.href === run.href
    ) {
      previous.text += run.text
      continue
    }
    merged.push({ ...run })
  }
  return merged
}

function headingLevelFor(styleId: string): number {
  if (/^title$/i.test(styleId)) return 1
  const match = /^heading\s*([1-9])$/i.exec(styleId)
  if (!match) return 0
  return Math.min(6, Number.parseInt(match[1], 10))
}

// ---- List membership ----
//
// A paragraph can be a list item two different ways, and real documents use
// both. Inline `w:pPr/w:numPr` is the obvious one. The other — which the
// ribbon's list buttons and every docx generator that uses the built-in
// "List Bullet" / "List Number" styles produce — puts the numbering reference
// on the *style*, leaving the paragraph itself carrying nothing but
// `<w:pStyle w:val="ListBullet"/>`. Reading only the inline form silently
// renders those documents' lists as plain paragraphs.

interface StyleInfo {
  basedOn: string | null
  numId: number | null
  ilvl: number | null
}

type StyleMap = Map<string, StyleInfo>

/** Style chains are shallow in practice; this only guards against a cycle. */
const MAX_STYLE_DEPTH = 12

async function readStyles(zip: ZipArchive): Promise<StyleMap> {
  const styles: StyleMap = new Map()
  const bytes = await zip.readOptional(STYLES_PART)
  if (!bytes) return styles

  let doc: Document
  try {
    doc = parseXml(bytes, STYLES_PART)
  } catch {
    return styles
  }

  for (const style of descendants(doc, NS.w, 'style')) {
    const id = attr(style, NS.w, 'styleId')
    if (!id) continue
    const numPr = firstChild(firstChild(style, NS.w, 'pPr'), NS.w, 'numPr')
    styles.set(id, {
      basedOn: attr(firstChild(style, NS.w, 'basedOn'), NS.w, 'val'),
      numId: intAttr(firstChild(numPr, NS.w, 'numId'), NS.w, 'val'),
      ilvl: intAttr(firstChild(numPr, NS.w, 'ilvl'), NS.w, 'val'),
    })
  }
  return styles
}

/**
 * The paragraph's list membership, or null if it is not a list item. Inline
 * `numPr` wins; otherwise the paragraph style's chain is searched.
 */
function resolveListMembership(
  pPr: Element | null,
  styleId: string,
  styles: StyleMap,
): { numId: number | null; level: number } | null {
  const numPr = firstChild(pPr, NS.w, 'numPr')
  if (numPr) {
    const numId = intAttr(firstChild(numPr, NS.w, 'numId'), NS.w, 'val')
    // numId 0 is Word's explicit "remove this paragraph from its list" — used
    // to opt a single paragraph out of a list-carrying style.
    if (numId === 0) return null
    return { numId, level: intAttr(firstChild(numPr, NS.w, 'ilvl'), NS.w, 'val') ?? 0 }
  }

  let currentId: string | null = styleId
  for (let depth = 0; currentId && depth < MAX_STYLE_DEPTH; depth++) {
    const style: StyleInfo | undefined = styles.get(currentId)
    if (!style) return null
    if (style.numId !== null && style.numId !== 0) {
      return { numId: style.numId, level: style.ilvl ?? 0 }
    }
    currentId = style.basedOn
  }
  return null
}

// ---- Numbering ----
//
// Only enough of numbering.xml to answer "is this level a numbered list or a
// bulleted one": w:num maps a numId to an abstractNumId, and the abstract
// definition carries a w:numFmt per level. Anything that is not "bullet" (or
// "none") is rendered as an ordered list.

type NumberingMap = {
  numToAbstract: Map<number, number>
  abstractLevelFormats: Map<number, Map<number, string>>
}

async function readNumbering(zip: ZipArchive): Promise<NumberingMap> {
  const empty: NumberingMap = { numToAbstract: new Map(), abstractLevelFormats: new Map() }
  const bytes = await zip.readOptional(NUMBERING_PART)
  if (!bytes) return empty

  let doc: Document
  try {
    doc = parseXml(bytes, NUMBERING_PART)
  } catch {
    // Numbering is cosmetic — a malformed part should not fail the document.
    return empty
  }

  const numToAbstract = new Map<number, number>()
  for (const num of descendants(doc, NS.w, 'num')) {
    const numId = intAttr(num, NS.w, 'numId')
    const abstractId = intAttr(firstChild(num, NS.w, 'abstractNumId'), NS.w, 'val')
    if (numId !== null && abstractId !== null) numToAbstract.set(numId, abstractId)
  }

  const abstractLevelFormats = new Map<number, Map<number, string>>()
  for (const abstract of descendants(doc, NS.w, 'abstractNum')) {
    const abstractId = intAttr(abstract, NS.w, 'abstractNumId')
    if (abstractId === null) continue
    const levels = new Map<number, string>()
    for (const lvl of children(abstract, NS.w, 'lvl')) {
      const level = intAttr(lvl, NS.w, 'ilvl')
      const format = attr(firstChild(lvl, NS.w, 'numFmt'), NS.w, 'val')
      if (level !== null && format) levels.set(level, format)
    }
    abstractLevelFormats.set(abstractId, levels)
  }

  return { numToAbstract, abstractLevelFormats }
}

function isOrderedList(numbering: NumberingMap, numId: number | null, level: number): boolean {
  if (numId === null) return false
  const abstractId = numbering.numToAbstract.get(numId)
  if (abstractId === undefined) return false
  const format = numbering.abstractLevelFormats.get(abstractId)?.get(level)
  if (!format) return false
  return format !== 'bullet' && format !== 'none'
}

/** Exported for the view: the plain text of a paragraph, for empty-check and copy. */
export function paragraphText(paragraph: DocxParagraph): string {
  return paragraph.runs.map((run) => run.text).join('')
}
