// The ONLY module in the app allowed to import monaco directly. Everything else
// imports `monaco` from here, which guarantees `setupMonaco()` has run.
//
// Entry points matter enormously. `monaco-editor` (the root) eagerly registers
// the TypeScript language feature, whose `languages.onLanguage('typescript')`
// hook dynamically imports a 12 MB payload the moment a .ts model is created.
// DevDeck gets all of its intelligence from the runtime language servers over
// /ws/lsp, so the language *features* are never imported — only the language
// *definitions*, which are monarch tokenizers with no workers.
import * as monaco from 'monaco-editor/editor'
import 'monaco-editor/features/register.all'
// Semantic highlighting — the feature that repaints identifiers from the
// language server's `textDocument/semanticTokens` instead of the monarch
// grammar, and the only reason a function name can look different from a
// variable.
//
// It has to be imported HERE, eagerly, for two compounding reasons:
//
//  - `features/register.all` ships only `viewportSemanticTokens`, which drives
//    *range* providers. `MonacoLspClient` registers a document provider and no
//    range provider, so the eager half of the pair has nothing to call.
//  - `registerEditorFeature`'s registry is read exactly once, when the first
//    code editor is constructed (see `editorFeatures.js`: "instantiated only
//    once, as soon as the first code editor is instantiated"). The LSP client
//    bundle imports this module itself, but it only loads when a file with a
//    language server is opened — always after some editor already exists — so
//    registering through that path is permanently too late.
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens'
import 'monaco-editor/languages/definitions/register.all'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import { DEVDECK_DARK, DEVDECK_LIGHT, devdeckDarkTheme, devdeckLightTheme } from './editorTheme'
import { registerJsonLanguage } from './jsonLanguage'
import { readThemePreference, resolveTheme, systemPrefersDark, type ResolvedTheme } from '@/features/theme/theme'

let initialized = false

export function setupMonaco() {
  if (initialized) return monaco
  initialized = true

  // Only the default editor worker is ever requested: with no language features
  // registered, monaco never asks for a 'typescript' / 'json' / 'css' / 'html'
  // worker label.
  window.MonacoEnvironment = { getWorker: () => new editorWorker() }

  monaco.editor.defineTheme(DEVDECK_DARK, devdeckDarkTheme)
  monaco.editor.defineTheme(DEVDECK_LIGHT, devdeckLightTheme)
  // Seeded from the stored preference rather than always dark, so an editor
  // mounted before `useThemeSync`'s first effect runs is not built dark and
  // then repainted.
  setMonacoTheme(resolveTheme(readThemePreference(), systemPrefersDark()))
  // JSON is the one language whose tokenizer is not in
  // `languages/definitions/register.all` — see jsonLanguage.ts. Registered
  // synchronously, before any caller can create a model: a `.json` model made
  // against an unregistered language id renders as plain text and does not
  // re-tokenize when the language shows up later.
  registerJsonLanguage()
  return monaco
}

/** monaco's theme is global, not per-editor, so one call repaints every open
 *  editor at once — no remount, no lost undo history. */
export function setMonacoTheme(resolved: ResolvedTheme) {
  monaco.editor.setTheme(resolved === 'light' ? DEVDECK_LIGHT : DEVDECK_DARK)
}

export { monaco, DEVDECK_DARK, DEVDECK_LIGHT }
