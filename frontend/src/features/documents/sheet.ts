// Reads an .xlsx into per-sheet string grids for the read-only viewer.
//
// Formulas are not evaluated — Excel caches every formula's last result in
// the file, and showing that cached value is both what the user saw when they
// saved and the only honest answer without a calculation engine.

import {
  attr,
  children,
  descendants,
  firstChild,
  intAttr,
  NS,
  OoxmlError,
  parseXml,
  readRelationships,
} from './ooxml'
import type { ZipArchive } from './zip'

const WORKBOOK_PART = 'xl/workbook.xml'
const SHARED_STRINGS_PART = 'xl/sharedStrings.xml'
const STYLES_PART = 'xl/styles.xml'

/**
 * Guard rails for a viewer, not a limit of the format. A single sheet can
 * legally hold ~1M × 16k cells; materialising that as a dense string grid
 * would exhaust memory long before anything rendered.
 */
export const MAX_ROWS = 5000
export const MAX_COLUMNS = 256

export interface SheetGrid {
  name: string
  /** Dense grid, row-major. Empty cells are `''`. */
  rows: string[][]
  columnCount: number
  /** True when the sheet was clipped by MAX_ROWS/MAX_COLUMNS. */
  truncated: boolean
  /** Real extent before clipping, for the "showing X of Y" note. */
  totalRows: number
  totalColumns: number
}

export interface Workbook {
  sheets: SheetGrid[]
}

export async function readWorkbook(zip: ZipArchive): Promise<Workbook> {
  const workbookBytes = await zip.readOptional(WORKBOOK_PART)
  if (!workbookBytes) {
    throw new OoxmlError('This does not look like an Excel workbook (no workbook part)')
  }

  const workbookDoc = parseXml(workbookBytes, WORKBOOK_PART)
  const rels = await readRelationships(zip, WORKBOOK_PART)
  const sharedStrings = await readSharedStrings(zip)
  const dateStyles = await readDateStyles(zip)

  const sheets: SheetGrid[] = []
  for (const sheetEl of descendants(workbookDoc, NS.s, 'sheet')) {
    const name = attr(sheetEl, null, 'name') ?? `Sheet${sheets.length + 1}`
    // Hidden sheets stay hidden — the workbook author's choice, and they are
    // usually lookup tables rather than content.
    if (attr(sheetEl, null, 'state') === 'hidden') continue

    const relId = attr(sheetEl, NS.rel, 'id')
    const target = relId ? rels.get(relId)?.target : undefined
    if (!target || !zip.has(target)) continue

    sheets.push(await readSheet(zip, target, name, sharedStrings, dateStyles))
  }

  if (sheets.length === 0) {
    throw new OoxmlError('This workbook has no readable sheets')
  }
  return { sheets }
}

async function readSheet(
  zip: ZipArchive,
  part: string,
  name: string,
  sharedStrings: string[],
  dateStyles: Set<number>,
): Promise<SheetGrid> {
  const doc = parseXml(await zip.read(part), part)

  // First pass: collect cells keyed by position so a sparse sheet does not
  // require guessing its extent up front. `r` (e.g. "C7") is optional per the
  // spec, so track a running position for producers that omit it.
  const cells = new Map<number, Map<number, string>>()
  let totalRows = 0
  let totalColumns = 0

  const sheetData = firstChild(doc.documentElement, NS.s, 'sheetData')
  let rowCursor = 0
  for (const rowEl of children(sheetData, NS.s, 'row')) {
    const declaredRow = intAttr(rowEl, null, 'r')
    const rowIndex = declaredRow !== null ? declaredRow - 1 : rowCursor
    rowCursor = rowIndex + 1
    totalRows = Math.max(totalRows, rowIndex + 1)

    let columnCursor = 0
    for (const cellEl of children(rowEl, NS.s, 'c')) {
      const ref = attr(cellEl, null, 'r')
      const parsed = ref ? parseCellRef(ref) : null
      const columnIndex = parsed ? parsed.column : columnCursor
      columnCursor = columnIndex + 1
      totalColumns = Math.max(totalColumns, columnIndex + 1)

      const text = cellText(cellEl, sharedStrings, dateStyles)
      if (text === '') continue
      if (rowIndex >= MAX_ROWS || columnIndex >= MAX_COLUMNS) continue

      let row = cells.get(rowIndex)
      if (!row) {
        row = new Map<number, string>()
        cells.set(rowIndex, row)
      }
      row.set(columnIndex, text)
    }
  }

  const rowCount = Math.min(totalRows, MAX_ROWS)
  const columnCount = Math.min(totalColumns, MAX_COLUMNS)
  const rows: string[][] = []
  for (let r = 0; r < rowCount; r++) {
    const source = cells.get(r)
    const row = new Array<string>(columnCount).fill('')
    if (source) for (const [column, value] of source) row[column] = value
    rows.push(row)
  }

  return {
    name,
    rows,
    columnCount,
    truncated: totalRows > MAX_ROWS || totalColumns > MAX_COLUMNS,
    totalRows,
    totalColumns,
  }
}

function cellText(cell: Element, sharedStrings: string[], dateStyles: Set<number>): string {
  const type = attr(cell, null, 't') ?? 'n'

  if (type === 'inlineStr') {
    return richText(firstChild(cell, NS.s, 'is'))
  }

  const valueEl = firstChild(cell, NS.s, 'v')
  const raw = valueEl?.textContent ?? ''
  if (raw === '') return ''

  switch (type) {
    case 's': {
      const index = Number.parseInt(raw, 10)
      return sharedStrings[index] ?? ''
    }
    case 'b':
      return raw === '1' || raw === 'true' ? 'TRUE' : 'FALSE'
    case 'e':
      // Error cells already carry their display text (#REF!, #DIV/0!).
      return raw
    case 'str':
      // Cached string result of a formula.
      return raw
    case 'd':
      // ISO 8601 dates — the 2012+ alternative to serial numbers.
      return raw
    default: {
      const styleIndex = intAttr(cell, null, 's')
      if (styleIndex !== null && dateStyles.has(styleIndex)) {
        const formatted = formatExcelDate(Number.parseFloat(raw))
        if (formatted) return formatted
      }
      return raw
    }
  }
}

/** Concatenates the text of a shared-string / inline-string element, runs included. */
function richText(el: Element | null): string {
  if (!el) return ''
  // `rPh` holds Japanese phonetic hints that duplicate the base text, so read
  // only the direct `t` and the `t` inside each formatting run `r`.
  let text = ''
  for (const t of children(el, NS.s, 't')) text += t.textContent ?? ''
  for (const run of children(el, NS.s, 'r')) {
    for (const t of children(run, NS.s, 't')) text += t.textContent ?? ''
  }
  return text
}

async function readSharedStrings(zip: ZipArchive): Promise<string[]> {
  const bytes = await zip.readOptional(SHARED_STRINGS_PART)
  if (!bytes) return []
  const doc = parseXml(bytes, SHARED_STRINGS_PART)
  const root = doc.documentElement
  return children(root, NS.s, 'si').map(richText)
}

// ---- Date detection ----
//
// A date in xlsx is just a number; only its *format* says otherwise. So the
// style table has to be read to know whether 45000 means 45000 or 2023-03-15.

/** Built-in numFmtIds that are date/time formats (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

async function readDateStyles(zip: ZipArchive): Promise<Set<number>> {
  const styleIndexes = new Set<number>()
  const bytes = await zip.readOptional(STYLES_PART)
  if (!bytes) return styleIndexes

  let doc: Document
  try {
    doc = parseXml(bytes, STYLES_PART)
  } catch {
    // Formatting is cosmetic — fall back to showing raw serials.
    return styleIndexes
  }

  const customDateFormats = new Set<number>()
  for (const numFmt of descendants(doc, NS.s, 'numFmt')) {
    const id = intAttr(numFmt, null, 'numFmtId')
    const code = attr(numFmt, null, 'formatCode') ?? ''
    if (id !== null && isDateFormatCode(code)) customDateFormats.add(id)
  }

  const cellXfs = firstChild(doc.documentElement, NS.s, 'cellXfs')
  children(cellXfs, NS.s, 'xf').forEach((xf, index) => {
    const numFmtId = intAttr(xf, null, 'numFmtId')
    if (numFmtId === null) return
    if (BUILTIN_DATE_FORMATS.has(numFmtId) || customDateFormats.has(numFmtId)) {
      styleIndexes.add(index)
    }
  })
  return styleIndexes
}

/**
 * Whether a format code renders a date. Strips the parts of a code that can
 * contain letters without implying a date — quoted literals, escaped
 * characters, colour/condition blocks in brackets — then looks for the
 * date/time placeholders.
 */
export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
  return /[ymdhs]/i.test(stripped)
}

/**
 * Excel's day 0 is 1899-12-31 and it wrongly treats 1900 as a leap year, so
 * serials line up with 1899-12-30 as the epoch for every date from 1900-03-01
 * on — which is every date anyone actually stores.
 */
export function formatExcelDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null

  const wholeDays = Math.floor(serial)
  const fraction = serial - wholeDays
  const epoch = Date.UTC(1899, 11, 30)
  const millis = epoch + wholeDays * 86_400_000 + Math.round(fraction * 86_400_000)
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) return null

  const yyyy = String(date.getUTCFullYear()).padStart(4, '0')
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const day = `${yyyy}-${mm}-${dd}`

  // A serial below 1 is a bare time-of-day; a whole number is a bare date.
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mi = String(date.getUTCMinutes()).padStart(2, '0')
  const ss = String(date.getUTCSeconds()).padStart(2, '0')
  if (fraction === 0) return day
  if (wholeDays === 0) return ss === '00' ? `${hh}:${mi}` : `${hh}:${mi}:${ss}`
  return ss === '00' ? `${day} ${hh}:${mi}` : `${day} ${hh}:${mi}:${ss}`
}

/** `"BC12"` → `{ column: 54, row: 11 }` (both 0-based). */
export function parseCellRef(ref: string): { column: number; row: number } | null {
  const match = /^([A-Za-z]+)(\d+)$/.exec(ref)
  if (!match) return null

  let column = 0
  for (const char of match[1].toUpperCase()) {
    column = column * 26 + (char.charCodeAt(0) - 64)
  }
  const row = Number.parseInt(match[2], 10)
  if (column <= 0 || row <= 0) return null
  return { column: column - 1, row: row - 1 }
}

/** `0` → `"A"`, `26` → `"AA"` — for the grid's column headers. */
export function columnLabel(index: number): string {
  let label = ''
  let n = index + 1
  while (n > 0) {
    const remainder = (n - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    n = Math.floor((n - 1) / 26)
  }
  return label
}
