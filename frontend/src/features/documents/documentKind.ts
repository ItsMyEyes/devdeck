// Which files open as a *rendered document* instead of as text in Monaco.
//
// The backend's file-read endpoint deliberately rejects anything that isn't
// valid UTF-8 (see WorktreeFileService.Read in
// backend/internal/service/worktree_file.go), so before this module every one
// of these formats opened to the same dead end: "…is not a UTF-8 text file".
// Routing them here instead sends the tab down the raw-bytes download path
// and renders the parsed content.

export type DocumentKind = 'pdf' | 'word' | 'excel' | 'powerpoint' | 'csv' | 'image' | 'video'

export interface DocumentFormat {
  kind: DocumentKind
  /** Human label for headers and error copy — "Word document", "PDF". */
  label: string
  /**
   * False for the pre-2007 binary formats (.doc/.xls/.ppt). Those are OLE2
   * compound files, not the zipped XML the parsers here understand, and a
   * from-scratch OLE2 + legacy-BIFF reader is far more code than the format
   * deserves in 2026. They still open as a document tab — just one that says
   * so and offers a download, which beats the UTF-8 error they hit before.
   *
   * Also false for the container formats no browser decodes (.mkv, .avi):
   * downloading half a gigabyte to hand `<video>` something it will refuse is
   * worse than saying so up front.
   */
  renderable: boolean
  /**
   * True when the bytes are ALSO valid UTF-8, so the tab can offer a way back
   * to the text editor. Only CSV and TSV: every other format here is binary,
   * and the editor rejects it outright (WorktreeFileService.Read).
   *
   * This flag is what keeps routing CSV to a grid from being a REGRESSION.
   * The grid is what an operator opening a data file wants to see, but a CSV
   * is still a text file someone may need to fix by hand, and silently
   * removing that would trade one complaint for another.
   */
  textEditable?: boolean
}

const PDF: DocumentFormat = { kind: 'pdf', label: 'PDF', renderable: true }

function word(renderable: boolean): DocumentFormat {
  return { kind: 'word', label: 'Word document', renderable }
}

function excel(renderable: boolean): DocumentFormat {
  return { kind: 'excel', label: 'Excel workbook', renderable }
}

function powerpoint(renderable: boolean): DocumentFormat {
  return { kind: 'powerpoint', label: 'PowerPoint presentation', renderable }
}

// One kind, two labels: the grid reads the delimiter off the text itself
// (detectDelimiter), so a .tsv needs no separate parse path — only an honest
// name in the tab header.
const CSV: DocumentFormat = { kind: 'csv', label: 'CSV', renderable: true, textEditable: true }
const TSV: DocumentFormat = { kind: 'csv', label: 'TSV', renderable: true, textEditable: true }

function image(renderable = true): DocumentFormat {
  return { kind: 'image', label: 'Image', renderable }
}

function video(renderable: boolean): DocumentFormat {
  return { kind: 'video', label: 'Video', renderable }
}

const FORMATS_BY_EXTENSION: Readonly<Record<string, DocumentFormat>> = {
  pdf: PDF,

  // Office Open XML (2007+) — a zip of XML parts, which is what docx.ts,
  // sheet.ts and slides.ts read. The macro-enabled and template variants use
  // the identical part layout, so they render through the same path.
  docx: word(true),
  docm: word(true),
  dotx: word(true),
  dotm: word(true),
  xlsx: excel(true),
  xlsm: excel(true),
  xltx: excel(true),
  xltm: excel(true),
  pptx: powerpoint(true),
  pptm: powerpoint(true),
  potx: powerpoint(true),
  potm: powerpoint(true),
  ppsx: powerpoint(true),
  ppsm: powerpoint(true),

  // Legacy binary formats — recognised so the tab explains itself, but not parsed.
  doc: word(false),
  dot: word(false),
  xls: excel(false),
  xlt: excel(false),
  ppt: powerpoint(false),
  pot: powerpoint(false),
  pps: powerpoint(false),

  // Delimited text. Valid UTF-8, so unlike everything above it opens in the
  // editor too — see DocumentFormat.textEditable.
  csv: CSV,
  tsv: TSV,

  // Raster images. Every one of these is binary, so before this they hit the
  // editor's "is not a UTF-8 text file" dead end — the exact failure this
  // module was created to route around for Office formats.
  //
  // .svg is deliberately absent: it IS UTF-8, Monaco opens it today, and
  // there is no bug to fix. Hijacking it into a preview would take away
  // editing the one image format that has source worth editing.
  png: image(),
  jpg: image(),
  jpeg: image(),
  gif: image(),
  webp: image(),
  avif: image(),
  bmp: image(),
  ico: image(),
  apng: image(),

  // Video. mp4/webm/ogv are decoded everywhere; .mov and .m4v are H.264 in a
  // QuickTime container, which the macOS WebView plays.
  mp4: video(true),
  m4v: video(true),
  mov: video(true),
  webm: video(true),
  ogv: video(true),
  // Containers no browser demuxes. Marked unrenderable so the tab says so
  // immediately instead of streaming a gigabyte to a <video> that will reject
  // it — see DocumentFormat.renderable.
  mkv: video(false),
  avi: video(false),
  wmv: video(false),
  flv: video(false),
}

/**
 * The MIME type to hand a blob URL for a media file, "" when the path is not
 * one. Keyed by extension rather than carried on DocumentFormat because one
 * format object is shared by many extensions, and `<img>`/`<video>` need the
 * specific type — a blob typed "image" renders nothing.
 */
const MEDIA_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
}

export function mediaMimeForPath(path: string): string {
  return MEDIA_MIME_BY_EXTENSION[extensionOf(path)] ?? ''
}

function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

/**
 * The document format for a path, or null if it should open as text.
 *
 * `.csv`/`.tsv` USED to be excluded here, on the reasoning that they are UTF-8
 * and Monaco already opens them. That was the wrong call in practice: a data
 * file is read as a table, not as quoted lines, and the editor is one click
 * away via DocumentFormat.textEditable — so nothing was actually lost by
 * making the grid the default.
 */
export function documentFormatForPath(path: string): DocumentFormat | null {
  // `extensionOf` returns "" for a dotfile named ".pdf", which is treated as a
  // hidden, extension-less file — which is what it is.
  const extension = extensionOf(path)
  if (!extension) return null
  return FORMATS_BY_EXTENSION[extension] ?? null
}

export function isDocumentPath(path: string): boolean {
  return documentFormatForPath(path) !== null
}
