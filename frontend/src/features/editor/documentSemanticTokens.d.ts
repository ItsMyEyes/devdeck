/** Types for monaco's `DocumentSemanticTokensFeature`, which ships as plain JS —
 *  `monaco-editor/esm/vs/editor/contrib/semanticTokens/browser/` contains only
 *  `.js` files, no declarations. Same situation, and same remedy, as the
 *  `monaco-lsp-client` alias in `features/terminal/lsp/monacoLspClient.d.ts`.
 *
 *  `monacoSetup.ts` imports the module for its registration side effect alone,
 *  which needs no types; this exists so `semanticTokens.guard.test.ts` can
 *  assert the feature is still exported from that path after a monaco upgrade. */
declare module 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens' {
  export const DocumentSemanticTokensFeature: new (...args: never[]) => unknown
}
