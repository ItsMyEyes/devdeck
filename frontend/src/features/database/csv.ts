/** RFC 4180 CSV parsing for the import wizard.
 *
 *  Pure functions, no DOM and no network — the wizard reads the file text
 *  itself (FileReader) and hands it here, so this module stays trivially
 *  testable (`npx tsx src/features/database/csv.test.ts`).
 */

export interface CSVParseError {
  /** 1-based index into `rows` (the *data* rows — the header line is not
   *  counted, and skipped blank lines never consume a number). */
  row: number
  message: string
}

export interface CSVParseResult {
  headers: string[]
  rows: string[][]
  errors: CSVParseError[]
}

export interface ParseCSVOptions {
  /** Single character. Defaults to ','. Use `detectDelimiter` to guess. */
  delimiter?: string
  /** Defaults to true. When false, headers are generated as column_1..n and
   *  every record — including the first — is returned as data. */
  hasHeader?: boolean
}

/** The delimiters `detectDelimiter` votes between, in tie-break order. */
const CANDIDATE_DELIMITERS = [',', ';', '\t']

const BOM = '﻿'

/** Splits raw CSV text into records of fields, honoring RFC 4180 quoting.
 *
 *  Rules that matter (and are pinned by tests):
 *  - A field is quoted only when the quote is its *first* character; a quote
 *    appearing mid-field (`5" pipe`) is a literal.
 *  - `""` inside a quoted field is one literal quote.
 *  - Delimiters and newlines inside quotes are data. CRLF inside quotes is
 *    normalized to a single LF so callers never see stray CRs.
 *  - Characters after a closing quote (`"pad" ,z`) are appended verbatim.
 *  - A wholly blank line is skipped, but a line containing an explicitly
 *    quoted empty field (`""`) is a real one-field record.
 *  - An unterminated quote at EOF is accepted leniently: the partial field is
 *    flushed rather than dropped, so the user still sees their data.
 */
function tokenize(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  /** True until the current field receives its first character — only then
   *  can a quote open a quoted section. */
  let atFieldStart = true
  /** Any quote seen anywhere in the current record; distinguishes a blank
   *  line (skip) from a `""` record (keep). */
  let recordHasQuote = false
  let i = 0

  const endField = () => {
    record.push(field)
    field = ''
    atFieldStart = true
  }

  const endRecord = () => {
    endField()
    // A blank line carries no quote and exactly one empty field.
    if (!(record.length === 1 && record[0] === '' && !recordHasQuote)) {
      records.push(record)
    }
    record = []
    recordHasQuote = false
  }

  while (i < text.length) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      if (ch === '\r') {
        field += '\n'
        i += text[i + 1] === '\n' ? 2 : 1
        continue
      }
      field += ch
      i += 1
      continue
    }

    if (atFieldStart && ch === '"') {
      inQuotes = true
      recordHasQuote = true
      atFieldStart = false
      i += 1
      continue
    }
    if (ch === delimiter) {
      endField()
      i += 1
      continue
    }
    if (ch === '\n' || ch === '\r') {
      endRecord()
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    atFieldStart = false
    i += 1
  }

  // Flush a final record only when one is actually pending — a trailing
  // newline must not produce a phantom empty row.
  if (record.length > 0 || !atFieldStart || inQuotes) {
    endRecord()
  }
  return records
}

export function parseCSV(text: string, opts: ParseCSVOptions = {}): CSVParseResult {
  const delimiter = opts.delimiter && opts.delimiter.length > 0 ? opts.delimiter[0] : ','
  const hasHeader = opts.hasHeader !== false
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text

  const records = tokenize(body, delimiter)
  if (records.length === 0) {
    return { headers: [], rows: [], errors: [] }
  }

  let headers: string[]
  let rows: string[][]
  if (hasHeader) {
    headers = records[0]
    rows = records.slice(1)
  } else {
    headers = records[0].map((_, idx) => `column_${idx + 1}`)
    rows = records
  }

  const errors: CSVParseError[] = []
  for (let idx = 0; idx < rows.length; idx += 1) {
    if (rows[idx].length !== headers.length) {
      errors.push({
        row: idx + 1,
        message: `expected ${headers.length} fields, got ${rows[idx].length}`,
      })
    }
  }
  // Ragged rows are reported, never repaired: padding would silently invent
  // values and truncating would silently drop them. The caller decides.
  return { headers, rows, errors }
}

/** Guesses the delimiter of a CSV sample among comma, semicolon and tab.
 *
 *  Each candidate is scored by tokenizing the sample *with that delimiter*
 *  (so quoted commas can't vote for comma) and looking at the first 10
 *  records: a candidate scores its field count only when every one of those
 *  records agrees and yields at least 2 fields; otherwise it scores 0. The
 *  highest score wins, ties break toward comma. A sample where nothing splits
 *  consistently (a single-column file, or empty text) falls back to comma.
 */
export function detectDelimiter(sampleText: string): string {
  const body = sampleText.startsWith(BOM) ? sampleText.slice(BOM.length) : sampleText
  let best = ','
  let bestScore = 0

  for (const candidate of CANDIDATE_DELIMITERS) {
    const records = tokenize(body, candidate).slice(0, 10)
    if (records.length === 0) continue
    const width = records[0].length
    if (width < 2) continue
    if (!records.every((r) => r.length === width)) continue
    if (width > bestScore) {
      bestScore = width
      best = candidate
    }
  }
  return best
}
