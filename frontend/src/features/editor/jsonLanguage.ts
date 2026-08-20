import type { languages } from 'monaco-editor/editor'
import { createTokenizationSupport } from 'monaco-editor/languages/features/json/tokenization'
import { monaco } from './monacoSetup'

/**
 * JSON syntax highlighting, without the JSON language *service*.
 *
 * Every other language DevDeck colours comes from `languages/definitions/
 * register.all` — monarch grammars, no workers. JSON is the one exception in
 * monaco's layout: there is no `basic-languages/json`, so both the language
 * registration and its tokenizer live under `languages/features/json`, next to
 * the schema validation and the worker that backs it. Importing that whole
 * feature is what `jsonMarkers.ts` explains DevDeck cannot do — `languages/
 * features/*` drags the TypeScript feature's 12 MB payload in with it — and
 * dropping it took JSON's colours along with the parts that were unwanted.
 * A `.json` file therefore opened as an unregistered language and rendered in
 * one flat foreground.
 *
 * `tokenization.js` is the worker-free half of that feature: a line-based
 * `TokensProvider` over jsonc-parser's scanner, with no dependency on
 * `jsonMode`, `workerManager`, or a `json` worker label. Registering it by hand
 * buys the colours and nothing else. Validation stays where it already is, in
 * `jsonMarkers.ts`.
 *
 * Deliberately NOT importing `languages/features/json/register.js`, which does
 * register the language correctly but also arms an `onLanguage('json')` hook
 * that dynamically pulls in `jsonMode` — and that asks `MonacoEnvironment` for
 * a worker labelled `json`. DevDeck hands out the plain editor worker for every
 * label (see `monacoSetup.ts`), which does not speak the JSON worker protocol.
 */

/** Mirrors monaco's own registration in `languages/features/json/register.js`,
 *  so a `.babelrc` or `.eslintrc` is coloured as JSON exactly as it is in VS
 *  Code — `languageForPath.ts` only resolves the plain `.json`/`.jsonc` cases. */
const JSON_LANGUAGE: languages.ILanguageExtensionPoint = {
  id: 'json',
  extensions: ['.json', '.bowerrc', '.jshintrc', '.jscsrc', '.eslintrc', '.babelrc', '.har'],
  aliases: ['JSON', 'json'],
  mimetypes: ['application/json'],
}

/** Copied from `jsonMode.js`'s `richEditConfiguration`, which is unreachable
 *  without importing the worker half of the feature. Brackets are what drive
 *  bracket-pair colouring, matching and the indent guides. */
const JSON_CONFIGURATION: languages.LanguageConfiguration = {
  wordPattern: /(-?\d*\.\d\w*)|([^[{\]}:",\s]+)/g,
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}', notIn: ['string'] },
    { open: '[', close: ']', notIn: ['string'] },
    { open: '"', close: '"', notIn: ['string'] },
  ],
}

let registered = false

/** Idempotent: `setupMonaco()` may be called from more than one entry point,
 *  and registering the same language twice leaves monaco with duplicate
 *  tokenizers. */
export function registerJsonLanguage() {
  if (registered) return
  registered = true

  // `json` is not among the languages monaco already knows about here, but
  // check rather than assume — a monaco upgrade that moves JSON into
  // basic-languages would otherwise silently double-register it.
  if (!monaco.languages.getLanguages().some((language) => language.id === 'json')) {
    monaco.languages.register(JSON_LANGUAGE)
  }
  monaco.languages.setLanguageConfiguration('json', JSON_CONFIGURATION)
  // `true` = tolerate comments, so a `.jsonc`-style settings file with `//`
  // notes colours its comments instead of drowning the rest of the file in
  // error tokens.
  monaco.languages.setTokensProvider('json', createTokenizationSupport(true))
}
