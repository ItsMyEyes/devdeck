// Which files open as a *rendered document* instead of as text in Monaco.
//
// The backend's file-read endpoint deliberately rejects anything that isn't
// valid UTF-8 (see WorktreeFileService.Read in
// backend/internal/service/worktree_file.go), so before this module every one
// of these formats opened to the same dead end: "…is not a UTF-8 text file".
// Routing them here instead sends the tab down the raw-bytes download path
// and renders the parsed content.

export type DocumentKind = 'pdf' | 'word' | 'excel' | 'powerpoint'

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
   */
  renderable: boolean
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
}

/**
 * The document format for a path, or null if it should open as text.
 *
 * Deliberately excludes `.csv`: it is UTF-8 text, Monaco already opens it,
 * and hijacking it into a read-only grid would take away editing.
 */
export function documentFormatForPath(path: string): DocumentFormat | null {
  const name = path.split('/').pop() ?? path
  // `<= 0` rather than `< 0` so a dotfile named ".pdf" is treated as a
  // hidden, extension-less file — which is what it is.
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return FORMATS_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null
}

export function isDocumentPath(path: string): boolean {
  return documentFormatForPath(path) !== null
}
