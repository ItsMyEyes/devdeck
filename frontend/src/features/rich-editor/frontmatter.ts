/**
 * YAML frontmatter is ordinary markdown to a parser but *structure* to
 * whatever reads the file (Jekyll, Astro, an agent's task file). Tiptap has no
 * node for it, so round-tripping `---\ntitle: x\n---` through the WYSIWYG
 * editor turns the fences into horizontal rules and the keys into a paragraph
 * — silently rewriting the file's metadata the first time someone types a
 * character. The block is therefore split off before parsing and re-attached
 * verbatim on serialize; the editor never sees it.
 */

/** A leading `---` fence, its body, the closing `---`, and the newline after
 *  it. Non-greedy, so on a document that also uses `---` as a horizontal rule
 *  further down the *first* closing fence wins. */
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** A YAML mapping key (`title:`) or a comment — the cheap tell that separates
 *  real frontmatter from a document that merely opens with two horizontal
 *  rules. Anything else stays in the body as ordinary markdown. */
const YAML_FIRST_LINE = /^(?:#|[A-Za-z_][\w.-]*\s*:)/

export interface SplitMarkdown {
  /** The frontmatter block verbatim — fences and trailing newline included —
   *  or `''` when the document has none. `join(split(source))` reproduces
   *  `source` byte for byte. */
  frontmatter: string
  /** Everything after the frontmatter: the part the editor round-trips. */
  body: string
}

export function splitFrontmatter(source: string): SplitMarkdown {
  const match = FRONTMATTER.exec(source)
  if (!match) return { frontmatter: '', body: source }
  const [firstLine] = match[1].split('\n', 1)
  if (!YAML_FIRST_LINE.test(firstLine.trim())) return { frontmatter: '', body: source }
  return { frontmatter: match[0], body: source.slice(match[0].length) }
}

export function joinFrontmatter(frontmatter: string, body: string): string {
  if (!frontmatter) return body
  if (!body) return frontmatter
  // A frontmatter block that ran to the end of the file has no trailing
  // newline (the regex's `$` branch). Once the body is no longer empty that
  // newline is what keeps the closing fence off the first line of prose.
  return frontmatter.endsWith('\n') ? frontmatter + body : `${frontmatter}\n${body}`
}
