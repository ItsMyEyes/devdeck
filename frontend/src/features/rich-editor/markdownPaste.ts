/** Structural markdown that a plain-text paste should render as rich content
 *  rather than drop in verbatim: ATX headings, list bullets, task boxes,
 *  numbered items, blockquotes, fences, and table rows. Anchored per line
 *  (`m` flag) because the tell usually isn't on the first one. */
const BLOCK_MARKDOWN = /^(?:#{1,6} |[-*+] |\d+\. |> |```|\|.*\|)/m

/** Inline markdown is a weaker signal — `**bold**`, `[text](url)`, `` `code` ``
 *  — so it only counts when the paste spans more than one line, which keeps a
 *  single word copied out of a code sample from being reinterpreted. */
const INLINE_MARKDOWN = /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`|^\s*---\s*$/m

/**
 * Whether a plain-text clipboard payload should be parsed as markdown.
 *
 * The cost of a false positive is real (a literal `*` gets eaten), so this
 * only fires on syntax that is unambiguous in context: an editor paste of
 * `1. foo` almost always means a numbered list, while a bare paragraph
 * containing an asterisk almost never means emphasis.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text.trim()) return false
  if (BLOCK_MARKDOWN.test(text)) return true
  return text.includes('\n') && INLINE_MARKDOWN.test(text)
}
