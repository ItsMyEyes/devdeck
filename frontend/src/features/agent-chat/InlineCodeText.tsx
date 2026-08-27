/**
 * Plain text with markdown INLINE CODE — `Source.IsManually()` — rendered as
 * code, and nothing else rendered at all.
 *
 * ── Why not Streamdown ──
 * The agent writes its `AskUserQuestion` questions and option descriptions in
 * markdown, and every one of them names a symbol or a path in backticks. Those
 * surfaces render the string verbatim (`{question}` in a `<p>`), so the operator
 * read `kondisi \`Source.IsManually()\` di titik ini` — the punctuation of a
 * markup language the card never applied. Running them through the transcript's
 * full markdown pipeline is the wrong fix: a question is one sentence in a
 * fixed-height card, and `MessageResponse` brings headings, lists, tables,
 * katex and mermaid, any of which would break the card's layout if a question
 * happened to start with `#`.
 *
 * So: one construct, the one that actually appears, and a total function over
 * the string. An unpaired backtick is content — `a ` b ` c` splits to three
 * segments and the odd one is code, but `a ` b` leaves the tail plain rather
 * than swallowing the rest of the sentence into a code span that never closes.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Alternating plain/code segments, plain first. Exported for the unit test —
 *  the split is the whole logic, and it is easier to assert on than on DOM. */
export function splitInlineCode(text: string): string[] {
  const parts = text.split('`')
  // An even number of backticks leaves an odd number of parts, each delimiter
  // properly paired. An odd count means the last delimiter never closed, so its
  // tail is folded back into the preceding plain segment, backtick included.
  if (parts.length % 2 === 0) {
    const tail = parts.pop() as string
    parts[parts.length - 1] = `${parts[parts.length - 1]}\`${tail}`
  }
  return parts
}

/** The inline-code chip. Deliberately fill-free: this renders on four different
 *  surfaces (the card, an idle option row, a selected option row's wash, the
 *  transcript's answered card), and mono plus a hairline reads as code on all of
 *  them where any one fill would vanish into one of them. */
const CODE = 'rounded-micro border border-devdeck-border-menu px-[0.3em] font-mono text-[0.92em]'

export function InlineCodeText({ text, className }: { text: string; className?: string }) {
  const segments = splitInlineCode(text)
  if (segments.length === 1) return <>{text}</>

  const nodes: ReactNode[] = []
  segments.forEach((segment, index) => {
    if (segment.length === 0) return
    if (index % 2 === 0) nodes.push(segment)
    else
      nodes.push(
        <code key={index} className={cn(CODE, className)}>
          {segment}
        </code>,
      )
  })
  return <>{nodes}</>
}
