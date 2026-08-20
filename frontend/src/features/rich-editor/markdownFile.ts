/**
 * Helpers for the difference between editing prose in a form field and
 * editing a markdown *file* on disk, where the bytes are under version
 * control and a stray reformat shows up in someone's diff.
 */

/** Fenced code blocks, so HTML inside a ``` example isn't mistaken for HTML
 *  the document actually renders. Matches the opening fence's length so an
 *  inner ``` doesn't end an outer ````. */
const FENCED_BLOCK = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm

/** Inline code spans, for the same reason — prose about `Array<string>` is
 *  not prose containing markup. */
const INLINE_CODE = /`[^`\n]*`/g

/** An HTML tag. Deliberately not a full parser and deliberately biased toward
 *  false positives: the cost of one is a file opening in raw mode, and the
 *  cost of a miss is silently deleting someone's markup. Requiring a letter
 *  straight after `<` is what keeps `a < b and b > c` out. */
const HTML_TAG = /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/

/**
 * Whether a markdown source contains raw HTML the WYSIWYG editor cannot round
 * trip.
 *
 * `@tiptap/markdown` parses HTML down to whatever nodes the schema has and
 * drops the rest, so `<details>…</details>` around a README section comes back
 * as bare paragraphs — the markup is gone the moment anything is typed. Files
 * like that open in raw mode instead; the rich editor is one click away for
 * anyone who doesn't care.
 */
export function containsRawHtml(markdown: string): boolean {
  return HTML_TAG.test(markdown.replace(FENCED_BLOCK, '').replace(INLINE_CODE, ''))
}

/** `getMarkdown()` never emits a trailing newline, so that is the editor's
 *  canonical form. Stripping it on the way in keeps the value handed back on
 *  the next render byte-identical to what the editor last emitted — otherwise
 *  every keystroke would look like an external change and reset the
 *  document, taking the caret and the undo stack with it. */
export function stripTrailingNewlines(body: string): string {
  return body.replace(/\n+$/, '')
}

/** The newline run `stripTrailingNewlines` removed, to be re-attached on the
 *  way out so a POSIX file keeps its final newline (and a file without one
 *  doesn't grow one). A body that is entirely empty gets a single newline —
 *  the first thing typed into a new file should still end properly. */
export function trailingNewlines(body: string): string {
  return /\n+$/.exec(body)?.[0] ?? (body === '' ? '\n' : '')
}
