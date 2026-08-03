// Shared plumbing for the three Office Open XML readers (docx.ts, sheet.ts,
// slides.ts): namespaces, namespace-aware DOM lookups, part-path resolution
// and the relationship (`_rels`) files that tie parts together.

import type { ZipArchive } from './zip'

/**
 * OOXML namespace URIs. These are frozen by the spec — the *prefixes* vary
 * between producers (and a part's main namespace is often the default, with
 * no prefix at all), so every lookup in these readers goes through the
 * namespace URI rather than a `w:`/`a:` qualified tag name.
 */
export const NS = {
  /** WordprocessingML — docx body content. */
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  /** DrawingML — shared shape/text model, used heavily by pptx. */
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  /** PresentationML — pptx slides. */
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  /** SpreadsheetML — xlsx workbook and sheets. */
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  /** The `_rels` file format itself. */
  packageRel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  /** The `r:id` / `r:embed` attributes that *reference* a relationship. */
  rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
} as const

export class OoxmlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OoxmlError'
  }
}

export function parseXml(bytes: Uint8Array, partName: string): Document {
  const text = new TextDecoder().decode(bytes)
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  // DOMParser reports XML errors as a <parsererror> element rather than by
  // throwing, and both browsers and jsdom namespace it differently — so look
  // for the element by local name anywhere in the tree.
  const failure = doc.getElementsByTagName('parsererror')[0]
  if (failure) throw new OoxmlError(`${partName} is not valid XML`)
  return doc
}

/** Direct child elements matching a namespaced tag. */
export function children(parent: Element | null, ns: string, local: string): Element[] {
  if (!parent) return []
  const out: Element[] = []
  for (const child of Array.from(parent.children)) {
    if (child.namespaceURI === ns && child.localName === local) out.push(child)
  }
  return out
}

export function firstChild(parent: Element | null, ns: string, local: string): Element | null {
  return children(parent, ns, local)[0] ?? null
}

/** Walks a path of nested single children — `path(root, NS.w, 'pPr', 'numPr', 'ilvl')`. */
export function path(root: Element | null, ns: string, ...locals: string[]): Element | null {
  let current = root
  for (const local of locals) {
    current = firstChild(current, ns, local)
    if (!current) return null
  }
  return current
}

/** All descendants matching a namespaced tag, in document order. */
export function descendants(root: Element | Document | null, ns: string, local: string): Element[] {
  if (!root) return []
  return Array.from(root.getElementsByTagNameNS(ns, local))
}

export function firstDescendant(
  root: Element | Document | null,
  ns: string,
  local: string,
): Element | null {
  if (!root) return null
  return root.getElementsByTagNameNS(ns, local)[0] ?? null
}

/**
 * A namespaced attribute (`w:val`, `r:id`). Pass `null` for `ns` to read an
 * unprefixed attribute — per XML rules those are in *no* namespace even when
 * the element itself sits in a default namespace, which is exactly the case
 * for spreadsheet cell attributes like `<c r="A1" t="s">`.
 */
export function attr(el: Element | null, ns: string | null, local: string): string | null {
  if (!el) return null
  return ns === null ? el.getAttribute(local) : el.getAttributeNS(ns, local)
}

export function intAttr(el: Element | null, ns: string | null, local: string): number | null {
  const raw = attr(el, ns, local)
  if (raw === null) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : null
}

/**
 * OOXML booleans: the attribute may be absent (element presence alone means
 * true, e.g. `<w:b/>`), or carry an explicit `w:val` of `0`/`false`/`off`.
 */
export function toggleValue(el: Element | null): boolean {
  if (!el) return false
  const raw = attr(el, NS.w, 'val')
  if (raw === null) return true
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

/**
 * Resolves a relationship target against the part that declared it.
 * `resolvePart('ppt/slides/slide1.xml', '../media/image2.png')` →
 * `ppt/media/image2.png`.
 */
export function resolvePart(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)

  const base = fromPart.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') base.pop()
    else base.push(segment)
  }
  return base.join('/')
}

/** `word/document.xml` → `word/_rels/document.xml.rels`. */
export function relsPartFor(part: string): string {
  const segments = part.split('/')
  const name = segments.pop() ?? part
  return [...segments, '_rels', `${name}.rels`].join('/')
}

export interface Relationship {
  id: string
  /** Already resolved to a full part path — ready to hand to `ZipArchive.read`. */
  target: string
  type: string
  /** True for links out of the package (a web URL); `target` is left verbatim. */
  external: boolean
}

/**
 * The relationships declared by a part, keyed by `r:id`. Missing `_rels`
 * files are normal (a part with no references has none), so this resolves to
 * an empty map rather than throwing.
 */
export async function readRelationships(
  zip: ZipArchive,
  part: string,
): Promise<Map<string, Relationship>> {
  const relsPart = relsPartFor(part)
  const bytes = await zip.readOptional(relsPart)
  const map = new Map<string, Relationship>()
  if (!bytes) return map

  const doc = parseXml(bytes, relsPart)
  for (const el of descendants(doc, NS.packageRel, 'Relationship')) {
    const id = el.getAttribute('Id')
    const rawTarget = el.getAttribute('Target')
    if (!id || !rawTarget) continue
    const external = el.getAttribute('TargetMode') === 'External'
    map.set(id, {
      id,
      target: external ? rawTarget : resolvePart(part, rawTarget),
      type: el.getAttribute('Type') ?? '',
      external,
    })
  }
  return map
}

/** MIME type for an embedded media part, from its extension. */
export function mediaMimeType(part: string): string {
  const extension = part.split('.').pop()?.toLowerCase() ?? ''
  switch (extension) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'tif':
    case 'tiff':
      return 'image/tiff'
    default:
      return 'application/octet-stream'
  }
}

/**
 * Whether a media part is something an `<img>` can actually display. Office
 * happily embeds EMF/WMF (Windows metafiles) and TIFF, which no browser
 * renders — surfacing those as broken images is worse than omitting them.
 */
export function isDisplayableImage(part: string): boolean {
  const mime = mediaMimeType(part)
  return mime.startsWith('image/') && mime !== 'image/tiff'
}
