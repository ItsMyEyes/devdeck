/**
 * The `<terminal_context>` block appended to a submitted message, and the
 * pure functions that build and strip it. Port of t3code's
 * `buildTerminalContextBlock`/`extractTrailingTerminalContexts`
 * (`t3code/apps/web/src/lib/terminalContext.ts:159-182,223-246`) — but
 * simplified per the spec ("Reading the chips from the document is a
 * deliberate simplification of t3code"): DevDeck's composer document holds
 * typed chip atoms, not `U+FFFC` placeholders in a plain string, so there is
 * no placeholder-counting/materializing/expiry machinery to port. Callers
 * (T15's `ExpandedTerminal`/`ChatComposer` bridge) read `terminalContext`
 * chips straight out of `editor.getJSON()`.
 *
 * The block header is the chip's serialized markdown-link **destination**
 * (`composerSerialize.ts`'s `terminal:<sessionKey>/L<start>-L<end>`), not a
 * human label — that is the join key back to the link in the visible text,
 * and is what `extractTrailingTerminalContexts` recovers, load-bearing for
 * the round-trip/join-key tests in `terminalContext.test.ts`.
 */

/** One captured terminal selection, keyed by its chip's link destination.
 *  `label` is carried for parity with the composer's capture map (built at
 *  capture time, alongside the chip's display label) but is not consumed
 *  here — the block header is the destination alone, so extraction can
 *  round-trip without a separate label channel. */
export interface TerminalContextCapture {
  /** T1's markdown-link destination, e.g. `terminal:sess-7f2a/L12-L40`. */
  destination: string
  label?: string
  text: string
}

/** What `extractTrailingTerminalContexts` recovers from a block — the
 *  destination and the captured text; the label is not stored in the block
 *  and cannot be recovered by this function alone. */
export interface TerminalContextEntry {
  destination: string
  text: string
}

const TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN =
  /\n*<terminal_context>\n([\s\S]*?)\n<\/terminal_context>\s*$/

function buildEntryBodyLines(text: string): string[] {
  return text.split('\n').map((line) => `  ${line}`)
}

/**
 * Appends a trailing `<terminal_context>` block to `text`, one entry per
 * capture, in the order given. Each entry's header is its `destination`
 * verbatim (the join key back to the chip's markdown link in `text`); the
 * body is the captured text, each line indented two spaces so a blank line
 * inside the capture survives round-tripping (an unindented blank line is
 * the entry separator, below).
 *
 * With no contexts, returns `text` unchanged — nothing is appended, mirroring
 * t3code's `appendTerminalContextsToPrompt` returning the bare prompt when
 * its block is empty.
 */
export function buildTerminalContextBlock(text: string, contexts: TerminalContextCapture[]): string {
  if (contexts.length === 0) return text

  const lines: string[] = []
  contexts.forEach((context, index) => {
    lines.push(`- ${context.destination}:`)
    lines.push(...buildEntryBodyLines(context.text))
    if (index < contexts.length - 1) lines.push('')
  })
  const block = ['<terminal_context>', ...lines, '</terminal_context>'].join('\n')

  return text.length > 0 ? `${text}\n\n${block}` : block
}

/**
 * Splits a message built by `buildTerminalContextBlock` back into the
 * visible text (block stripped, for the transcript bubble), the full
 * `copyText` (block intact, for "copy" — mirrors t3code's
 * `copyText`/`visibleText` split), and the parsed entries.
 *
 * No trailing block: `visibleText`/`copyText` both equal `text`, and
 * `contexts` is empty.
 */
export function extractTrailingTerminalContexts(text: string): {
  visibleText: string
  copyText: string
  contexts: TerminalContextEntry[]
} {
  const match = TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN.exec(text)
  if (!match) {
    return { visibleText: text, copyText: text, contexts: [] }
  }
  const visibleText = text.slice(0, match.index).replace(/\n+$/, '')
  return {
    visibleText,
    copyText: text,
    contexts: parseTerminalContextEntries(match[1] ?? ''),
  }
}

function parseTerminalContextEntries(block: string): TerminalContextEntry[] {
  const entries: TerminalContextEntry[] = []
  let current: { destination: string; bodyLines: string[] } | null = null

  const commitCurrent = () => {
    if (!current) return
    entries.push({ destination: current.destination, text: current.bodyLines.join('\n').trimEnd() })
    current = null
  }

  for (const rawLine of block.split('\n')) {
    const headerMatch = /^- (.+):$/.exec(rawLine)
    if (headerMatch) {
      commitCurrent()
      current = { destination: headerMatch[1]!, bodyLines: [] }
      continue
    }
    if (!current) continue
    if (rawLine.startsWith('  ')) {
      current.bodyLines.push(rawLine.slice(2))
      continue
    }
    if (rawLine.length === 0) {
      current.bodyLines.push('')
    }
  }

  commitCurrent()
  return entries
}
