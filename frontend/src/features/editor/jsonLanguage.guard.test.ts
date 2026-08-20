import { describe, expect, it } from 'vitest'
import { ONE_DARK_PRO_DARKER_TOKEN } from '@/lib/oneDarkProDarker'
import { devdeckDarkTheme } from './editorTheme'

/**
 * JSON highlighting rests on two things monaco gives no compile-time guarantee
 * about. Both are pinned here, because either one failing brings back the same
 * symptom — a `.json` file rendered in one flat colour — with no error anywhere.
 */
describe('json highlighting', () => {
  /**
   * There is no `basic-languages/json`: the tokenizer lives inside the language
   * *feature*, which DevDeck cannot ship whole (see jsonMarkers.ts — it drags
   * the TypeScript feature's 12 MB in). `tokenization.js` is the worker-free
   * half, reached by a deep path that only resolves through monaco's `./*`
   * export wildcard. If a monaco upgrade moves it, `jsonLanguage.ts` breaks.
   */
  it('resolves monaco’s worker-free JSON tokenizer', async () => {
    const mod = await import('monaco-editor/languages/features/json/tokenization')
    expect(typeof mod.createTokenizationSupport).toBe('function')

    // Shape it must keep to be accepted by `languages.setTokensProvider`.
    const provider = mod.createTokenizationSupport(true)
    expect(typeof provider.getInitialState).toBe('function')
    expect(typeof provider.tokenize).toBe('function')
  })

  /**
   * `inherit: true` merges monaco's built-in vs-dark, which ships its own
   * `keyword.json` (CE9178 — the string colour). A longer scope wins in the
   * theme trie, so a generic `keyword` rule cannot override it and
   * `true`/`false`/`null` render as if they were strings. These three rules
   * must stay suffix-qualified.
   */
  it('overrides the inherited vs-dark JSON rules with One Dark colours', () => {
    const byToken = new Map(devdeckDarkTheme.rules.map((rule) => [rule.token, rule.foreground]))
    // One Dark's own JSON colours: the constant orange for the literals,
    // `support.type.property-name.json` coral for the key, plain `string` for
    // the value. The first two are *not* what the generic `keyword` / `string`
    // rules would give, which is half the reason these three exist.
    expect(byToken.get('keyword.json')).toBe(ONE_DARK_PRO_DARKER_TOKEN.orange)
    expect(byToken.get('string.key.json')).toBe(ONE_DARK_PRO_DARKER_TOKEN.coral)
    expect(byToken.get('string.value.json')).toBe(ONE_DARK_PRO_DARKER_TOKEN.string)
    expect(byToken.get('keyword.json')).not.toBe(byToken.get('keyword'))
    expect(byToken.get('string.key.json')).not.toBe(byToken.get('string'))
  })

  it('keeps the generic rules the suffixed ones cannot replace', () => {
    const byToken = new Map(devdeckDarkTheme.rules.map((rule) => [rule.token, rule.foreground]))
    // number.json / delimiter.*.json have no entry in monaco's base theme, so
    // they do resolve through these.
    expect(byToken.get('number')).toBe(ONE_DARK_PRO_DARKER_TOKEN.orange)
    expect(byToken.get('delimiter')).toBe(ONE_DARK_PRO_DARKER_TOKEN.fg)
  })
})
