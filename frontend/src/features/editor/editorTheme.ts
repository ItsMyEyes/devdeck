import type { editor } from 'monaco-editor/editor'
import { ONE_DARK_PRO_DARKER_EDITOR, ONE_DARK_PRO_DARKER_TOKEN as hue } from '@/lib/oneDarkProDarker'

export const DEVDECK_DARK = 'devdeck-dark'
export const DEVDECK_LIGHT = 'devdeck-light'

/**
 * One Dark Pro **Darker** — the syntax colours only.
 *
 * Monaco does not take a VS Code theme file: it colours by its own coarse
 * token names (`keyword`, `string`, `type`, …) rather than by TextMate scope,
 * so the upstream theme's 272 scope rules cannot simply be dropped in. What
 * follows maps each monaco token onto the scope One Dark would have matched
 * for it — the reasoning per rule is in the comments — reading the palette
 * from `@/lib/oneDarkProDarker`, which is also what the chat's shiki-rendered
 * code blocks use. One palette, both renderers.
 *
 * Only the *code* colours change. Everything under `colors` below still
 * describes DevDeck's editor chrome, which stays where it was.
 */
export const devdeckDarkTheme: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // Darker's whole quarrel with plain One Dark Pro is italics: it drops the
    // four `fontStyle: 'italic'` rules the base theme carries, comments first.
    { token: 'comment', foreground: hue.comment },
    { token: 'keyword', foreground: hue.purple },
    { token: 'keyword.control', foreground: hue.purple },
    { token: 'string', foreground: hue.string },
    // `constant.character.escape`.
    { token: 'string.escape', foreground: hue.cyan },

    // JSON, whose tokenizer tags every token with a `.json` suffix and splits a
    // pair into `string.key` / `string.value` (see jsonLanguage.ts).
    //
    // These have to be spelled out with the suffix, and cannot be left to the
    // generic `string` / `keyword` rules above: `inherit: true` merges monaco's
    // built-in vs-dark, which carries its own `string.key.json`,
    // `string.value.json` and `keyword.json` entries
    // (`editor/standalone/common/themes.js`). A longer scope wins in the theme
    // trie, so the inherited rules beat anything shorter declared here —
    // monaco's `keyword.json` is CE9178, which painted `true`/`false`/`null`
    // the same orange as a string.
    //
    // The colours are One Dark's own JSON rules: `support.type.property-name
    // .json` for the key, and — since the theme's one `constant.language.json`
    // rule is a `>` child selector that the grammar's nesting never satisfies —
    // plain `constant` for `true` / `false` / `null`, which lands them on the
    // number colour rather than anywhere near the purple of a `keyword`.
    { token: 'string.key.json', foreground: hue.coral },
    { token: 'string.value.json', foreground: hue.string },
    { token: 'keyword.json', foreground: hue.orange },
    { token: 'number', foreground: hue.orange },
    // Upstream lists `string.regexp` twice, cyan and then coral; VS Code and
    // shiki both let the later rule win, so coral it is.
    { token: 'regexp', foreground: hue.coral },
    { token: 'type', foreground: hue.yellow },
    { token: 'type.identifier', foreground: hue.yellow },
    { token: 'namespace', foreground: hue.yellow },
    { token: 'struct', foreground: hue.yellow },
    { token: 'interface', foreground: hue.yellow },
    { token: 'function', foreground: hue.blue },
    // `variable.other.readwrite` — a plain identifier reference. This is the
    // colour that makes One Dark look like One Dark.
    { token: 'identifier', foreground: hue.coral },
    { token: 'variable', foreground: hue.coral },
    // `variable.language`: `this`, `self`, `cls`.
    { token: 'variable.predefined', foreground: hue.yellow },
    { token: 'constant', foreground: hue.orange },
    // Parameters reach monaco as an LSP semantic token, which VS Code resolves
    // through the scope `variable.parameter`. One Dark has no rule at that
    // length — its `variable.parameter.function` is *longer*, so it cannot
    // match — and the lookup falls back to `variable`, the same coral as any
    // other identifier. Confirmed against shiki in oneDarkProDarker.test.ts.
    { token: 'parameter', foreground: hue.coral },
    // `meta.object-literal.key` / `support.variable.property`.
    { token: 'property', foreground: hue.coral },
    // Only the *specific* operator scopes are cyan upstream (logical,
    // arithmetic, comparison, assignment); monaco has no finer split, and
    // those are what its `operator` token actually covers.
    { token: 'operator', foreground: hue.cyan },
    { token: 'delimiter', foreground: hue.fg },

    // ── LSP semantic tokens ────────────────────────────────────────────────
    // Monaco resolves a semantic token by matching `[type, ...modifiers]`
    // joined with dots against these same rules (`StandaloneTheme
    // .getTokenStyleMetadata` → `TokenTheme._match`), so the entries above
    // already cover `function`, `type`, `namespace`, `variable`, `parameter`
    // and `property`. These are the types they miss.
    //
    // Every rule is a prefix match, which is what lets `function` alone paint
    // gopls' `function.definition.signature` for a `func main()` declaration.
    { token: 'method', foreground: hue.blue },
    // `macro` and `enumMember` are two of the ten entries in the upstream
    // theme's own `semanticTokenColors`, so these are its stated answers.
    { token: 'macro', foreground: hue.orange },
    { token: 'decorator', foreground: hue.blue },
    { token: 'class', foreground: hue.yellow },
    { token: 'enum', foreground: hue.yellow },
    { token: 'typeParameter', foreground: hue.yellow },
    { token: 'enumMember', foreground: hue.cyan },
    { token: 'event', foreground: hue.cyan },
    { token: 'modifier', foreground: hue.purple },
    { token: 'label', foreground: hue.coral },
    // Constants. Prefix matching means only a *leading* `readonly` modifier is
    // reachable, and gopls orders its legend `definition, readonly, …`, so a
    // declared const arrives as `variable.definition.readonly` — both spellings
    // are listed rather than relying on one of them. Upstream's semantic
    // `variable.constant` is the orange constant colour.
    { token: 'variable.readonly', foreground: hue.orange },
    { token: 'variable.definition.readonly', foreground: hue.orange },
    { token: 'tag', foreground: hue.coral },
    { token: 'attribute.name', foreground: hue.orange },
    { token: 'attribute.value', foreground: hue.string },
    // `punctuation.section.embedded` — `<?php`, `<!DOCTYPE`, `#!`.
    { token: 'metatag', foreground: hue.purple },
    // `storage.type.annotation.java`, Java/Kotlin `@Foo`.
    { token: 'annotation', foreground: hue.yellow },
    // Upstream paints every `invalid.*` white rather than red; the error
    // squiggle under it is what carries the alarm.
    { token: 'invalid', foreground: hue.invalid },
  ],
  colors: {
    'editor.background': '#1E1E1E',
    'editor.foreground': ONE_DARK_PRO_DARKER_EDITOR.foreground,
    'editorLineNumber.foreground': '#858585',
    'editorLineNumber.activeForeground': '#C6C6C6',
    'editor.lineHighlightBackground': '#2A2D2E40',
    'editor.selectionBackground': '#264F78',
    'editor.inactiveSelectionBackground': '#3A3D41',
    'editor.selectionHighlightBackground': '#ADD6FF26',
    'editor.wordHighlightBackground': '#575757B8',
    'editor.wordHighlightStrongBackground': '#004972B8',
    'editor.findMatchBackground': '#515C6A',
    'editor.findMatchHighlightBackground': '#EA5C0055',
    'editorCursor.foreground': '#AEAFAD',
    'editorWhitespace.foreground': '#3B3B3B',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
    'editorGutter.background': '#1E1E1E',
    'editorBracketMatch.background': '#0064001A',
    'editorBracketMatch.border': '#888888',
    // Bracket-pair colourisation is syntax colour under another name, so these
    // three come from One Dark too.
    'editorBracketHighlight.foreground1': ONE_DARK_PRO_DARKER_EDITOR.bracket1,
    'editorBracketHighlight.foreground2': ONE_DARK_PRO_DARKER_EDITOR.bracket2,
    'editorBracketHighlight.foreground3': ONE_DARK_PRO_DARKER_EDITOR.bracket3,
    'editorError.foreground': '#F14C4C',
    'editorWarning.foreground': '#CCA700',
    'editorInfo.foreground': '#3794FF',
    'editorWidget.background': '#252526',
    'editorWidget.border': '#454545',
    'editorSuggestWidget.background': '#252526',
    'editorSuggestWidget.border': '#454545',
    'editorSuggestWidget.selectedBackground': '#04395E',
    'editorSuggestWidget.highlightForeground': '#2AAAFF',
    'editorHoverWidget.background': '#252526',
    'editorHoverWidget.border': '#454545',
    'editorStickyScroll.background': '#1E1E1E',
    'editorOverviewRuler.border': '#7F7F7F4D',
    'minimap.background': '#1E1E1E',
    'scrollbarSlider.background': '#79797966',
    'scrollbarSlider.hoverBackground': '#646464B3',
    'scrollbarSlider.activeBackground': '#BFBFBF66',
  },
}

/**
 * Visual Studio Code's "Light+" palette, the theme monaco is switched to when
 * the app is in light mode.
 *
 * Deliberately *not* One Dark: the upstream project ships no light variant of
 * it, and inventing one by lightening nine hues would be a different theme
 * wearing its name. Light mode keeps the Light+ colours it already had.
 *
 * Same structure, same token names, same reasoning — including the two JSON
 * notes above. The one difference worth calling out: `inherit: true` here
 * merges monaco's built-in **vs** theme rather than **vs-dark**, and that base
 * carries its own `string.key.json` / `string.value.json` / `keyword.json`
 * entries too (`editor/standalone/common/themes.js`), so the same three
 * suffix-qualified overrides are required to reach Light+'s colours.
 */
export const devdeckLightTheme: editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '008000', fontStyle: 'italic' },
    { token: 'keyword', foreground: '0000FF' },
    { token: 'keyword.control', foreground: 'AF00DB' },
    { token: 'string', foreground: 'A31515' },
    { token: 'string.escape', foreground: 'EE0000' },

    { token: 'string.key.json', foreground: '0451A5' },
    { token: 'string.value.json', foreground: 'A31515' },
    { token: 'keyword.json', foreground: '0000FF' },

    { token: 'number', foreground: '098658' },
    { token: 'regexp', foreground: '811F3F' },
    { token: 'type', foreground: '267F99' },
    { token: 'type.identifier', foreground: '267F99' },
    { token: 'namespace', foreground: '267F99' },
    { token: 'struct', foreground: '267F99' },
    { token: 'interface', foreground: '267F99' },
    { token: 'function', foreground: '795E26' },
    { token: 'identifier', foreground: '001080' },
    { token: 'variable', foreground: '001080' },
    { token: 'variable.predefined', foreground: '0070C1' },
    { token: 'constant', foreground: '0070C1' },
    { token: 'parameter', foreground: '001080' },
    { token: 'property', foreground: '001080' },
    { token: 'operator', foreground: '000000' },
    { token: 'delimiter', foreground: '000000' },

    // LSP semantic tokens — see the dark theme for how monaco matches these.
    { token: 'method', foreground: '795E26' },
    { token: 'macro', foreground: '795E26' },
    { token: 'decorator', foreground: '795E26' },
    { token: 'class', foreground: '267F99' },
    { token: 'enum', foreground: '267F99' },
    { token: 'typeParameter', foreground: '267F99' },
    { token: 'enumMember', foreground: '0070C1' },
    { token: 'event', foreground: '0070C1' },
    { token: 'modifier', foreground: '0000FF' },
    { token: 'label', foreground: '000000' },
    { token: 'variable.readonly', foreground: '0070C1' },
    { token: 'variable.definition.readonly', foreground: '0070C1' },

    { token: 'tag', foreground: '800000' },
    { token: 'attribute.name', foreground: 'E50000' },
    { token: 'attribute.value', foreground: '0451A5' },
    { token: 'metatag', foreground: '0000FF' },
    { token: 'annotation', foreground: '795E26' },
    { token: 'invalid', foreground: 'CD3131' },
  ],
  colors: {
    'editor.background': '#FFFFFF',
    'editor.foreground': '#3B3B3B',
    'editorLineNumber.foreground': '#6E7681',
    'editorLineNumber.activeForeground': '#171184',
    'editor.lineHighlightBackground': '#E8E8E840',
    'editor.selectionBackground': '#ADD6FF',
    'editor.inactiveSelectionBackground': '#E5EBF1',
    'editor.selectionHighlightBackground': '#ADD6FF80',
    'editor.wordHighlightBackground': '#57575740',
    'editor.wordHighlightStrongBackground': '#0E639C40',
    'editor.findMatchBackground': '#A8AC94',
    'editor.findMatchHighlightBackground': '#EA5C0055',
    'editorCursor.foreground': '#000000',
    'editorWhitespace.foreground': '#D3D3D3',
    'editorIndentGuide.background1': '#D3D3D3',
    'editorIndentGuide.activeBackground1': '#939393',
    'editorGutter.background': '#FFFFFF',
    'editorBracketMatch.background': '#0064001A',
    'editorBracketMatch.border': '#B9B9B9',
    'editorBracketHighlight.foreground1': '#0431FA',
    'editorBracketHighlight.foreground2': '#319331',
    'editorBracketHighlight.foreground3': '#7B3814',
    'editorError.foreground': '#E51400',
    'editorWarning.foreground': '#BF8803',
    'editorInfo.foreground': '#1A85FF',
    'editorWidget.background': '#F3F3F3',
    'editorWidget.border': '#C8C8C8',
    'editorSuggestWidget.background': '#F3F3F3',
    'editorSuggestWidget.border': '#C8C8C8',
    'editorSuggestWidget.selectedBackground': '#D6EBFF',
    'editorSuggestWidget.highlightForeground': '#0066BF',
    'editorHoverWidget.background': '#F3F3F3',
    'editorHoverWidget.border': '#C8C8C8',
    'editorStickyScroll.background': '#FFFFFF',
    'editorOverviewRuler.border': '#7F7F7F4D',
    'minimap.background': '#FFFFFF',
    'scrollbarSlider.background': '#64646466',
    'scrollbarSlider.hoverBackground': '#646464B3',
    'scrollbarSlider.activeBackground': '#00000066',
  },
}
