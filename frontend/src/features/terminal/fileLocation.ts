/** A 1-based caret target parsed off the end of a quick-open query, matching
 *  both the editor's own coordinate system and the `path:line:column` shape
 *  every compiler, linter, stack trace and `rg -n` line already emits. */
export interface FileLocation {
  line: number
  /** Absent when the user only gave a line (`main.go:42`) — the caret then
   *  lands at the start of that line. */
  column?: number
}

export interface ParsedFileQuery {
  /** The path portion, i.e. what actually gets searched for. */
  query: string
  /** Undefined unless a complete `:line` suffix was present. */
  location?: FileLocation
}

/** Splits a trailing `:line` / `:line:column` suffix off a quick-open query so
 *  a pasted `src/App.tsx:123:23` finds `src/App.tsx` and opens it at 123:23.
 *
 *  Deliberately conservative — everything below stays a plain search:
 *    - a bare `:42` (no path portion), which is a literal filename fragment
 *    - a trailing `:` or `:123:` mid-typing, so results don't blank out
 *      between the keystrokes of a location the user is still typing
 *    - `:0` or negative/overflowing numbers, which no editor can honour
 *  A path containing a real colon therefore only loses its suffix when that
 *  suffix is digits, which is the same trade every editor's quick-open makes. */
export function parseFileQuery(input: string): ParsedFileQuery {
  const trimmed = input.trim()
  // The `:line:column` form is tried first and separately rather than folded
  // into one pattern with an optional third group: a single greedy `.*` would
  // rather grow the path than fill that optional group, so `main.go:9:1` would
  // parse as the path `main.go:9` at line 1.
  const match = /^(.*[^:\s]):(\d+):(\d+)$/.exec(trimmed) ?? /^(.*[^:\s]):(\d+)$/.exec(trimmed)
  if (!match) return { query: trimmed }

  const [, path, rawLine, rawColumn] = match
  const line = Number(rawLine)
  // A `:0` prefix (or a number past Number.MAX_SAFE_INTEGER) is not a location
  // anyone meant; leaving it in the query keeps the search honest.
  if (!Number.isSafeInteger(line) || line < 1) return { query: trimmed }

  if (rawColumn === undefined) return { query: path, location: { line } }

  const column = Number(rawColumn)
  if (!Number.isSafeInteger(column) || column < 1) return { query: path, location: { line } }
  return { query: path, location: { line, column } }
}

/** `src/App.tsx:123:23` — the suffix, rendered back to the user as
 *  confirmation that the typed location was understood. */
export function formatFileLocation(location: FileLocation) {
  return location.column === undefined ? `:${location.line}` : `:${location.line}:${location.column}`
}
