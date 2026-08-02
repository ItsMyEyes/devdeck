/**
 * Replaces `@codemirror/lang-json`'s `jsonParseLinter`. Monaco's own JSON
 * language feature would do this — and schema validation besides — but it is
 * deliberately not shipped: pulling `languages/features/*` in also registers the
 * TypeScript feature's 12 MB payload. For a settings file, a parse check is
 * enough.
 *
 * V8, SpiderMonkey and JavaScriptCore all report a character offset in the
 * message ("at position 12"), and V8 additionally reports "(line 3 column 7)".
 * Both shapes are handled; anything unrecognised falls back to line 1 so the
 * error is still surfaced rather than swallowed.
 */
export function jsonParseMarker(text: string) {
  if (!text.trim()) return null
  try {
    JSON.parse(text)
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON'

    const lineColumn = /line (\d+) column (\d+)/.exec(message)
    if (lineColumn) {
      return { message, line: Number(lineColumn[1]), column: Number(lineColumn[2]) }
    }

    const position = /position (\d+)/.exec(message)
    if (position) {
      const offset = Math.min(Number(position[1]), text.length)
      const before = text.slice(0, offset)
      return {
        message,
        line: before.split('\n').length,
        column: offset - (before.lastIndexOf('\n') + 1) + 1,
      }
    }

    return { message, line: 1, column: 1 }
  }
}
