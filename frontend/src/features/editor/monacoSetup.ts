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
import 'monaco-editor/languages/definitions/register.all'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import { DEVDECK_DARK, devdeckDarkTheme } from './editorTheme'

let initialized = false

export function setupMonaco() {
  if (initialized) return monaco
  initialized = true

  // Only the default editor worker is ever requested: with no language features
  // registered, monaco never asks for a 'typescript' / 'json' / 'css' / 'html'
  // worker label.
  window.MonacoEnvironment = { getWorker: () => new editorWorker() }

  monaco.editor.defineTheme(DEVDECK_DARK, devdeckDarkTheme)
  monaco.editor.setTheme(DEVDECK_DARK)
  return monaco
}

export { monaco, DEVDECK_DARK }
