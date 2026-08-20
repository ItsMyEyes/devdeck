import type { ThemeRegistration } from 'shiki'
import { ONE_DARK_PRO_DARKER_TOKEN_COLORS } from './oneDarkProDarker.tokenColors'

/**
 * One Dark Pro **Darker** — the palette DevDeck colours code with.
 *
 * DevDeck borrows this theme for syntax highlighting only. Panels, tabs, the
 * sidebar and every other surface stay on the DevDeck tokens in `globals.css`;
 * what changes is the colour of the *code* inside them, in both places code is
 * drawn: monaco (`features/editor/editorTheme.ts`) and shiki (the chat's
 * fenced blocks, via `components/ai-elements/codeHighlighter.ts`).
 *
 * The names are the ones the One Dark family has always used, so a rule here
 * can be read against the upstream `tokenColors` without a decoder ring.
 */
export const ONE_DARK_PRO_DARKER = {
  /** Default code text. Punctuation, delimiters, plain operators, parameters. */
  fg: '#abb2bf',
  comment: '#7f848e',
  /** Variables, object keys, tags, JSON property names. */
  coral: '#e06c75',
  string: '#98c379',
  /** Types, classes, namespaces, `this` / `self`. */
  yellow: '#e5c07b',
  /** Numbers, constants, HTML attribute names. */
  orange: '#d19a66',
  /** Functions and methods. */
  blue: '#61afef',
  /** Keywords and storage. */
  purple: '#c678dd',
  /** Operators, escapes, enum members, regex bodies. */
  cyan: '#56b6c2',
  /** Illegal / broken / deprecated tokens, which upstream renders bright. */
  invalid: '#ffffff',
} as const

/**
 * The same palette with the `#` stripped.
 *
 * Monaco's `IStandaloneThemeData.rules[].foreground` is *not* a CSS colour —
 * it goes through monaco's own `parseTokenTheme`, which wants a bare six-digit
 * hex and drops any rule it cannot parse. `colors` on the same object, being
 * workbench colours, does take the `#`. Keeping both forms here means the two
 * spellings can never drift apart.
 */
export const ONE_DARK_PRO_DARKER_TOKEN = Object.fromEntries(
  Object.entries(ONE_DARK_PRO_DARKER).map(([name, hex]) => [name, hex.slice(1)]),
) as { [K in keyof typeof ONE_DARK_PRO_DARKER]: string }

/**
 * The `editor.*` colours — the only entries from the theme's `colors` block
 * that describe the code area rather than workbench chrome.
 *
 * `background` is what shiki hands back as the code block's own backdrop, and
 * the bracket trio is bracket-pair colourisation, which is syntax colour by
 * another name.
 */
export const ONE_DARK_PRO_DARKER_EDITOR = {
  background: '#23272e',
  foreground: ONE_DARK_PRO_DARKER.fg,
  bracket1: ONE_DARK_PRO_DARKER.orange,
  bracket2: ONE_DARK_PRO_DARKER.purple,
  bracket3: ONE_DARK_PRO_DARKER.cyan,
} as const

/** The name shiki registers the theme under, and the key it is looked up by. */
export const ONE_DARK_PRO_DARKER_NAME = 'one-dark-pro-darker'

/**
 * The theme in shiki's own shape, for the chat's fenced code blocks.
 *
 * `colors` carries `editor.foreground` / `editor.background` because that is
 * where shiki's `normalizeTheme` reads a theme's `fg` / `bg` from when the
 * theme has no scope-less global rule — leave them out and every block would
 * fall back to shiki's `#1e1e1e` stand-in instead of One Dark's own backdrop.
 *
 * The upstream `semanticTokenColors` are not carried over: shiki has no
 * language server to produce a semantic token, and ignores the field. Monaco
 * does get them over LSP, and `editorTheme.ts` maps them across there.
 */
export const oneDarkProDarkerShikiTheme: ThemeRegistration = {
  name: ONE_DARK_PRO_DARKER_NAME,
  type: 'dark',
  colors: {
    'editor.background': ONE_DARK_PRO_DARKER_EDITOR.background,
    'editor.foreground': ONE_DARK_PRO_DARKER_EDITOR.foreground,
  },
  tokenColors: ONE_DARK_PRO_DARKER_TOKEN_COLORS,
}
