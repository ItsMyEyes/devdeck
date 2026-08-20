/** Types for the worker-free half of monaco's JSON language feature, which
 *  ships as plain JS with no declaration file. Same situation, and same remedy,
 *  as `documentSemanticTokens.d.ts` and the `monaco-lsp-client` alias.
 *
 *  See `jsonLanguage.ts` for why this one module is imported rather than the
 *  `languages/features/json/register.js` that would normally provide it. */
declare module 'monaco-editor/languages/features/json/tokenization' {
  import type { languages } from 'monaco-editor/editor'

  /** `supportComments` tolerates `//` and `/* *​/` instead of tokenizing them
   *  as errors. */
  export function createTokenizationSupport(supportComments: boolean): languages.TokensProvider
}
