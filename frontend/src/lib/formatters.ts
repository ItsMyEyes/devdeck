// Client-side beautify/parse helpers for the JSON/XML/CSV formatter tool.
// Pure functions only — no DOM state, safe to unit test and reuse.

export type DataFormat = 'json' | 'xml' | 'csv'

/** Guesses a data format from raw text so the formatter tool can default sensibly. */
export function detectFormat(input: string): DataFormat {
  const trimmed = input.trim()
  if (!trimmed) return 'json'
  if (trimmed.startsWith('<')) return 'xml'
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  const firstLine = trimmed.split(/\r?\n/, 1)[0]
  if (firstLine.includes('\t')) return 'csv'
  if (firstLine.includes(',') || firstLine.includes(';')) return 'csv'
  return 'json'
}

export interface JsonFormatResult {
  pretty: string
  value: unknown
}

/** Parses JSON and re-serializes it indented. Throws with the native SyntaxError message on invalid input. */
export function formatJson(input: string): JsonFormatResult {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Nothing to format')
  const value = JSON.parse(trimmed)
  return { pretty: JSON.stringify(value, null, 2), value }
}

/** Detects the most likely field delimiter by comparing counts on the first line. */
export function detectCsvDelimiter(input: string): string {
  const firstLine = input.split(/\r?\n/, 1)[0] ?? ''
  const candidates = [',', ';', '\t', '|']
  let best = ','
  let bestCount = -1
  for (const c of candidates) {
    const count = firstLine.split(c).length - 1
    if (count > bestCount) {
      best = c
      bestCount = count
    }
  }
  return best
}

/** RFC4180-ish CSV parser: handles quoted fields with embedded delimiters, newlines, and escaped quotes. */
export function parseCsv(input: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
    } else if (c === delimiter) {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c === '\r') {
      // paired \n handles the line break
    } else {
      field += c
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

export interface CsvFormatResult {
  rows: string[][]
  delimiter: string
  aligned: string
}

/** Parses CSV (auto-detecting the delimiter) and produces a whitespace-aligned monospace rendering. */
export function formatCsv(input: string): CsvFormatResult {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Nothing to format')
  const delimiter = detectCsvDelimiter(trimmed)
  const rows = parseCsv(trimmed, delimiter)
  if (rows.length === 0) throw new Error('No rows found')
  const colCount = Math.max(...rows.map((r) => r.length))
  const widths = new Array(colCount).fill(0)
  for (const r of rows) {
    r.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], cell.length)
    })
  }
  const aligned = rows
    .map((r) => Array.from({ length: colCount }, (_, i) => (r[i] ?? '').padEnd(widths[i])).join('  ').trimEnd())
    .join('\n')
  return { rows, delimiter, aligned }
}

const VOID_LOOKING_TEXT_ONLY = new Set(['#text', '#comment'])

/** Pretty-prints XML with 2-space indentation via DOMParser; throws on malformed markup. */
export function formatXml(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Nothing to format')

  const doc = new DOMParser().parseFromString(trimmed, 'application/xml')
  const parserError = doc.getElementsByTagName('parsererror')[0]
  if (parserError) {
    throw new Error(parserError.textContent?.trim().split('\n')[0] || 'Invalid XML')
  }
  if (!doc.documentElement || VOID_LOOKING_TEXT_ONLY.has(doc.documentElement.nodeName)) {
    throw new Error('Invalid XML')
  }

  const lines: string[] = []

  function walk(node: ChildNode, depth: number) {
    const indent = '  '.repeat(depth)
    if (node.nodeType === Node.COMMENT_NODE) {
      lines.push(`${indent}<!--${node.textContent}-->`)
      return
    }
    if (node.nodeType === Node.CDATA_SECTION_NODE) {
      lines.push(`${indent}<![CDATA[${node.textContent}]]>`)
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim()
      if (text) lines.push(`${indent}${text}`)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return

    const el = node as Element
    const attrs = Array.from(el.attributes)
      .map((a) => ` ${a.name}="${a.value}"`)
      .join('')
    const children = Array.from(el.childNodes).filter(
      (c) => !(c.nodeType === Node.TEXT_NODE && !c.textContent?.trim()),
    )

    if (children.length === 0) {
      lines.push(`${indent}<${el.tagName}${attrs} />`)
      return
    }
    if (children.length === 1 && children[0].nodeType === Node.TEXT_NODE) {
      lines.push(`${indent}<${el.tagName}${attrs}>${children[0].textContent?.trim()}</${el.tagName}>`)
      return
    }
    lines.push(`${indent}<${el.tagName}${attrs}>`)
    for (const child of children) walk(child, depth + 1)
    lines.push(`${indent}</${el.tagName}>`)
  }

  let declaration = ''
  const declMatch = trimmed.match(/^<\?xml[^?]*\?>/)
  if (declMatch) declaration = declMatch[0] + '\n'

  walk(doc.documentElement, 0)
  return declaration + lines.join('\n')
}

/** Escapes text for safe injection into an HTML string via a controlled highlighter. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Tokenizes pretty-printed JSON into an HTML string with type-colored spans (keys/strings/numbers/booleans/null). */
export function highlightJsonHtml(pretty: string): string {
  const escaped = escapeHtml(pretty)
  return escaped.replace(
    /"(?:\\u[0-9a-fA-F]{4}|\\.|[^"\\])*"(?:\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (match) => {
      let cls = 'text-loom-accent-soft' // number
      if (match.startsWith('"')) {
        cls = match.trimEnd().endsWith(':') ? 'text-loom-purple' : 'text-loom-green-soft'
      } else if (match === 'true' || match === 'false') {
        cls = 'text-loom-accent'
      } else if (match === 'null') {
        cls = 'text-loom-dim'
      }
      return `<span class="${cls}">${match}</span>`
    },
  )
}

/** Tokenizes pretty-printed XML into an HTML string with tag/attribute/comment-colored spans. */
export function highlightXmlHtml(pretty: string): string {
  const escaped = escapeHtml(pretty)
  return escaped
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="text-loom-dim">$1</span>')
    .replace(/(&lt;\/?)([a-zA-Z0-9:_-]+)/g, '$1<span class="text-loom-accent-soft">$2</span>')
    .replace(
      /([a-zA-Z0-9:_-]+)(=)(&quot;[^&]*&quot;|"[^"]*")/g,
      '<span class="text-loom-purple">$1</span>$2<span class="text-loom-green-soft">$3</span>',
    )
}
