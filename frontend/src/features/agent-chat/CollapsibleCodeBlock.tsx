/**
 * Streamdown's `pre` renderer, replaced so a long fenced code block in an agent
 * reply can be folded away.
 *
 * ── Why this exists ──
 * An agent answer is often mostly code, and Streamdown renders every fenced
 * block at full height. A reply carrying three 80-line files pushed its own
 * prose — the part that says what was done and why — several screens down, and
 * there was no way to put the code away again once read.
 *
 * ── Why a `pre` override and not a patch to the vendored code block ──
 * The block itself comes from `@streamdown/code`, inside Streamdown, and is not
 * ours to reach into. But Streamdown maps the fence's wrapper element through
 * `components.pre`, so wrapping is available at exactly the boundary where the
 * whole block is one child. `CODE_FENCE_COMPONENTS` below is what call sites
 * hand to `MessageResponse`.
 *
 * Streamdown's own default `pre` clones its child to add `data-block="true"`;
 * that is reproduced here rather than dropped, since it is Streamdown's marker
 * and not this app's to remove.
 *
 * ── Why short blocks get no control ──
 * A toggle above a three-line snippet is more chrome than the snippet, which is
 * the problem this is meant to solve rather than a second instance of it. Below
 * the threshold the block renders exactly as before, wrapper and all.
 */
import { cloneElement, isValidElement, useEffect, useId, useState } from 'react'
import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { Check, ChevronRight, Copy, WrapText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MaterialFileIcon } from '@/features/terminal/MaterialFileIcon'

/**
 * Line count above which a block arrives folded.
 *
 * 16 is about half the transcript's visible height at a typical pane size: a
 * block that cannot be taken in without scrolling is one worth offering to put
 * away, and anything shorter is quicker to read than to decide about.
 */
const FOLD_ABOVE_LINES = 16

/** The `<code>` child's props, as far as this file needs them: react-markdown
 *  hands the fence's source down as `children` and its language as
 *  `language-<lang>` in `className`. Both are read defensively — a fence with no
 *  language has no `className` at all, and a plugin is free to hand down
 *  something other than a bare string. */
type CodeChildProps = { children?: ReactNode; className?: string }

/** The fence's source text, or '' when it is not the plain string
 *  react-markdown normally provides. '' means "no line count", which lands
 *  below the threshold and therefore renders untouched — the safe direction to
 *  fail in. */
function fenceSource(child: ReactNode): string {
  if (!isValidElement(child)) return ''
  const { children } = child.props as CodeChildProps
  if (typeof children === 'string') return children
  // A single-element array is what some remark pipelines produce.
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === 'string') return children[0]
  return ''
}

/** The fence's declared language, for the collapsed row's label. `undefined`
 *  for a fence opened with no language, which is why the label has to read
 *  without one. */
function fenceLanguage(child: ReactNode): string | undefined {
  if (!isValidElement(child)) return undefined
  const { className } = child.props as CodeChildProps
  const match = /language-([\w+-]+)/.exec(className ?? '')
  return match?.[1]
}

/** `68 lines of go` / `68 lines` — what the fold is hiding, so the decision to
 *  open it can be made without opening it. */
function foldLabel(lines: number, language: string | undefined): string {
  const count = `${lines} ${lines === 1 ? 'line' : 'lines'}`
  return language ? `${count} of ${language}` : count
}

/** The filename `MaterialFileIcon` is asked to pick an icon for, synthesised
 *  from the fence's declared language — `bash` becomes `code.bash`, which that
 *  component's extension table maps to the console glyph. A fence with no
 *  language, or one whose extension it does not know, lands on the generic file
 *  icon, which is the right answer for "some code, unspecified".
 *
 *  A synthetic name rather than a lookup table of our own: the mapping from
 *  extension to icon already exists and already covers ~40 languages, and a
 *  second table beside it would only ever be a subset that drifts. */
function iconNameForLanguage(language: string | undefined): string {
  return `code.${language ?? 'txt'}`
}

/**
 * Only `children` is read of the props Streamdown hands the `pre` renderer.
 * The rest are deliberately dropped rather than forwarded: they are typed for a
 * `<pre>` (`ref` included) and this returns a `<div>`, and the wrapper carries
 * its own margin and layout regardless. The highlighted block itself — the
 * child — keeps every prop it arrived with.
 *
 * ── The chrome ──
 * Every fence now carries a header: the language as an icon on the left, and a
 * line-wrap toggle and a copy button on the right. Streamdown renders its own
 * version of both halves — a lowercase language word, and a copy/download pair
 * floated over the block — and `globals.css` hides them inside this wrapper.
 * Reproducing them rather than restyling them is what buys the two things its
 * own cannot do: an icon in place of the word, and a wrap toggle, which
 * Streamdown has no equivalent of at all.
 *
 * Wrapping is per-block and defaults OFF. A wrapped long line is unreadable as
 * a COMMAND — the thing most fences in an ops transcript are — but a
 * horizontally scrolled one hides its own tail, so neither default is right for
 * every block and the operator picks per block. The state is deliberately not
 * persisted: it belongs to the block being read, not to the app.
 */
export function CollapsibleCodeBlock({ children }: ComponentProps<'pre'>) {
  // Streamdown's default `pre` behaviour, preserved — see the file comment.
  const block = isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'data-block'?: string }>, { 'data-block': 'true' })
    : children

  const source = fenceSource(children)
  const language = fenceLanguage(children)
  const lines = source.length === 0 ? 0 : source.replace(/\n$/, '').split('\n').length
  const foldable = lines > FOLD_ABOVE_LINES

  const [open, setOpen] = useState(false)
  const [wrapped, setWrapped] = useState(false)
  const [copied, setCopied] = useState(false)
  const bodyId = useId()

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(id)
  }, [copied])

  // No readable source — either not the element react-markdown normally hands
  // down, or a genuinely empty fence. There is nothing to copy, nothing to
  // wrap and nothing to fold, so the chrome would be three controls over an
  // unknown quantity: a copy button that silently yields '' is worse than no
  // copy button. Rendered exactly as it arrived, the same safe direction
  // `fenceSource` already fails in.
  if (source.length === 0) return <>{block}</>

  function copy() {
    void navigator.clipboard?.writeText(source).then(() => setCopied(true))
  }

  return (
    <div className="chat-code my-[0.85em]" data-wrap={wrapped ? 'true' : 'false'} data-language={language}>
      <div className="chat-code-header">
        <MaterialFileIcon name={iconNameForLanguage(language)} size={14} />
        {/* The fold control doubles as the header's label when there is one to
            show — a second row carrying just `68 lines of go` would push the
            block further down the reply for a line of text the header has room
            for. Below the threshold the header simply has no label, which is
            the shape the icon was chosen to carry on its own. */}
        {foldable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((current) => !current)}
            className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-devdeck-fg-2 transition-colors hover:text-devdeck-fg"
          >
            <ChevronRight aria-hidden="true" className={cn('size-3 transition-transform', open && 'rotate-90')} />
            {foldLabel(lines, language)}
          </button>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          aria-pressed={wrapped}
          aria-label={wrapped ? 'Disable line wrap' : 'Wrap lines'}
          title={wrapped ? 'Disable line wrap' : 'Wrap lines'}
          onClick={() => setWrapped((current) => !current)}
          className="chat-code-action"
        >
          <WrapText aria-hidden="true" className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={copied ? 'Copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy code'}
          onClick={copy}
          className="chat-code-action"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5 text-devdeck-run" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
        </button>
      </div>
      {/* Unmounted rather than hidden while folded. A fenced block carries a
          fully highlighted token tree per line, and a reply with several long
          blocks is the case this is here to make cheap — keeping them all
          mounted behind `display: none` would spend the layout cost anyway. */}
      <div id={bodyId} hidden={foldable && !open}>
        {foldable && !open ? null : block}
      </div>
    </div>
  )
}

/**
 * The `components` map every chat markdown surface passes to Streamdown. A
 * module-level constant, not an inline object literal: `MessageResponse` is
 * `memo`ised on `children` identity, and a fresh `components` object on each
 * render would defeat that for every message in the transcript at once.
 */
export const CODE_FENCE_COMPONENTS = { pre: CollapsibleCodeBlock }
