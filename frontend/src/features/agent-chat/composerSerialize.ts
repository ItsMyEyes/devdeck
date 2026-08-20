/**
 * The prompt editor's document, and the pure mapping between it and the
 * `string` sent to the backend. No TipTap import, no React, no DOM — the
 * editor (`ComposerPromptEditor.tsx`, T5) hands this module plain JSON and
 * gets plain JSON or a string back, so the mapping is testable in total
 * isolation from ProseMirror.
 *
 * The document is inline content only, matching the spec: no headings,
 * lists, marks, or block nodes — just text and chip atoms, directly in
 * `doc.content` (no paragraph wrapper).
 */

/** Mirrors the three TipTap node types the editor registers
 *  (`composerFileChip`, `composerSkillChip`, `composerTerminalContextChip` —
 *  see `composerNodes.ts`). Only `file` is ever inserted by this spec's `@`
 *  trigger; the other two are defined for later specs. */
export type ComposerChipKind = 'file' | 'skill' | 'terminalContext'

/**
 * A file chip serializes to a markdown link, `[app.tsx](src/app.tsx)` — the
 * same format t3code sends (`serializeComposerFileLink`, and the escaping
 * helpers below are ported from `packages/shared/src/composerTrigger.ts`).
 *
 * Not `@src/app.tsx`, which this originally used and which is broken by
 * construction: a bare prefix has no terminator, so a chip run together with
 * whatever follows it produces one unparseable token. `@src/app.tsxplease` and
 * `@a.ts@b.ts` are both real outputs of that scheme, and no separator rule
 * fixes it in general — `@my file.tsx` is ambiguous no matter what, because
 * paths may contain the separator. Brackets delimit the path themselves, so
 * adjacency stops mattering.
 */
function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('#', '%23')
    .replaceAll('?', '%3F')
    .replaceAll('\\', '%5C')
}

export interface ComposerTextNode {
  type: 'text'
  text: string
}

export interface ComposerChipNode {
  type: 'chip'
  kind: ComposerChipKind
  /** The raw value placed after the prefix — e.g. the file path. This, not
   *  `label`, is what round-trips into the sent string. */
  value: string
  /** Display label, for the node view, if it should differ from `value`.
   *  Purely presentational for `file` and `skill` chips — both ignore it and
   *  serialize `value` alone. A `terminalContext` chip is the exception: its
   *  label, when present, becomes the markdown link's visible text (falling
   *  back to `value` verbatim when absent) — see `serializeInlineNode`. */
  label?: string
}

export type ComposerInlineNode = ComposerTextNode | ComposerChipNode

export interface ComposerDoc {
  type: 'doc'
  content: ComposerInlineNode[]
}

export function composerText(text: string): ComposerTextNode {
  return { type: 'text', text }
}

function composerChip(kind: ComposerChipKind, value: string, label?: string): ComposerChipNode {
  return label === undefined ? { type: 'chip', kind, value } : { type: 'chip', kind, value, label }
}

export function composerFileChip(value: string, label?: string): ComposerChipNode {
  return composerChip('file', value, label)
}

export function composerSkillChip(value: string, label?: string): ComposerChipNode {
  return composerChip('skill', value, label)
}

export function composerTerminalContextChip(value: string, label?: string): ComposerChipNode {
  return composerChip('terminalContext', value, label)
}

export function emptyComposerDoc(): ComposerDoc {
  return { type: 'doc', content: [] }
}

function serializeInlineNode(node: ComposerInlineNode): string {
  if (node.type === 'text') return node.text
  if (node.kind === 'file') {
    const label = escapeMarkdownLinkLabel(composerFileLinkBasename(node.value))
    return `[${label}](${encodeMarkdownLinkDestination(node.value)})`
  }
  if (node.kind === 'skill') {
    // Brackets delimit the label; ':skill' as a literal destination scheme
    // (never run through the encoder, so it can't be swallowed) is what makes
    // this mutually exclusive with a file chip's destination — see the
    // discrimination-invariant test above.
    const label = escapeMarkdownLinkLabel(`$${node.value}`)
    return `[${label}](skill:${encodeMarkdownLinkDestination(node.value)})`
  }
  // terminalContext: same markdown-link shape as a file chip, keyed by a
  // 'terminal:' scheme instead of a bare path. `node.value` carries no
  // 'terminal:' prefix itself — that's added here, at serialize time; the
  // producer that inserts this chip passes value = '<sessionKey>/L<start>-L<end>'
  // (the join key into the `<terminal_context>` block appended at submit
  // time). Unlike file/skill, the label is not purely presentational here:
  // when supplied it is what gets serialized, falling back to `value`
  // verbatim (there is no "basename" to derive a fallback from — a session
  // key is opaque).
  const label = escapeMarkdownLinkLabel(node.label ?? node.value)
  return `[${label}](${encodeMarkdownLinkDestination(`terminal:${node.value}`)})`
}

/** Doc → string. What gets sent to the backend, and what `onSend`/`onChange`
 *  see — the parent's contract is unchanged by anything this editor does
 *  internally. */
export function serializeComposerDoc(doc: ComposerDoc): string {
  return doc.content.map(serializeInlineNode).join('')
}

/** String → doc. One-way in the other direction: a chip is a live node while
 *  it exists in the editor, but nothing in a plain string (e.g. `@src/app.tsx`
 *  loaded back from an external value) can be reliably told apart from text
 *  the user actually typed, so this never reconstructs chips — it always
 *  produces a single text node. */
export function parseComposerText(text: string): ComposerDoc {
  if (text.length === 0) return emptyComposerDoc()
  return { type: 'doc', content: [composerText(text)] }
}
