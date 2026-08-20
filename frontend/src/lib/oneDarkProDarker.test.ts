import type { BundledLanguage } from 'shiki'
import { createHighlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ONE_DARK_PRO_DARKER,
  ONE_DARK_PRO_DARKER_EDITOR,
  ONE_DARK_PRO_DARKER_NAME,
  oneDarkProDarkerShikiTheme,
} from './oneDarkProDarker'

/**
 * The vendored theme is data, and data of this shape fails quietly: a rule
 * shiki cannot parse, a `tokenColors` array that never reached `settings`, a
 * name the lookup misses — all of them end in code drawn at the fallback
 * foreground, with nothing thrown and nothing logged. So rather than assert on
 * the object, this runs the real highlighter over real source and reads the
 * colours back off the tokens.
 *
 * The engine is the JavaScript one on purpose: it is what `@streamdown/code`
 * builds its highlighter with, so this exercises the same regex behaviour the
 * chat does rather than oniguruma's.
 */
const engine = createJavaScriptRegexEngine({ forgiving: true })

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>
let highlighter: Highlighter

beforeAll(async () => {
  highlighter = await createHighlighter({
    themes: [oneDarkProDarkerShikiTheme],
    langs: ['tsx', 'go', 'json'],
    engine,
  })
})

/** `content -> colour` for every non-blank token, lowercased to compare. */
const colourise = (code: string, lang: BundledLanguage) => {
  const { tokens } = highlighter.codeToTokens(code, { lang, theme: ONE_DARK_PRO_DARKER_NAME })
  const out = new Map<string, string>()
  for (const token of tokens.flat()) {
    const content = token.content.trim()
    if (content && !out.has(content)) {
      out.set(content, (token.color ?? '').toLowerCase())
    }
  }
  return out
}

describe('One Dark Pro Darker, as shiki renders it', () => {
  it('colours TypeScript the way the palette says', () => {
    const c = colourise(
      '// a note\nconst greet = (name: string) => `hi ${name}`\nconst n = 42\n',
      'tsx',
    )
    expect(c.get('// a note')).toBe(ONE_DARK_PRO_DARKER.comment)
    expect(c.get('const')).toBe(ONE_DARK_PRO_DARKER.purple)
    expect(c.get('greet')).toBe(ONE_DARK_PRO_DARKER.blue)
    expect(c.get('string')).toBe(ONE_DARK_PRO_DARKER.yellow)
    expect(c.get('42')).toBe(ONE_DARK_PRO_DARKER.orange)
    expect(c.get('`hi')).toBe(ONE_DARK_PRO_DARKER.string)
  })

  /**
   * Pins the two monaco rules that could not be read off a scope name and had
   * to be settled here instead — see the comments on `parameter` and
   * `keyword.json` in `features/editor/editorTheme.ts`.
   */
  it('leaves a parameter on the plain variable colour', () => {
    const c = colourise('func Add(a int, b int) int {\n\treturn a + b\n}\n', 'go')
    expect(c.get('a')).toBe(ONE_DARK_PRO_DARKER.coral)
    expect(c.get('Add')).toBe(ONE_DARK_PRO_DARKER.blue)
  })

  it('colours JSON literals as constants, not as keywords', () => {
    const c = colourise('{ "key": true, "n": 1, "s": "v" }\n', 'json')
    expect(c.get('"key"')).toBe(ONE_DARK_PRO_DARKER.coral)
    expect(c.get('true')).toBe(ONE_DARK_PRO_DARKER.orange)
    expect(c.get('true')).not.toBe(ONE_DARK_PRO_DARKER.purple)
    expect(c.get('"v"')).toBe(ONE_DARK_PRO_DARKER.string)
  })

  /** Shiki hands these to the renderer as the code block's own surface. */
  it('reports the theme’s own fg and bg', () => {
    const result = highlighter.codeToTokens('const a = 1\n', {
      lang: 'tsx',
      theme: ONE_DARK_PRO_DARKER_NAME,
    })
    expect(result.fg?.toLowerCase()).toBe(ONE_DARK_PRO_DARKER_EDITOR.foreground)
    expect(result.bg?.toLowerCase()).toBe(ONE_DARK_PRO_DARKER_EDITOR.background)
  })
})
