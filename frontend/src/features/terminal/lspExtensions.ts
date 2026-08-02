import { autocompletion, completeAnyWord, type CompletionSource } from '@codemirror/autocomplete'
import { Prec, type Extension, type Text } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  formatDocument,
  formatSelection,
  formattingOptions,
  languageServerPlugin,
  languageServerWithTransport,
  SynchronizationMethod,
} from 'codemirror-languageserver'
import { CompletionTriggerKind } from 'vscode-languageserver-protocol'
import { toast } from 'sonner'
import type { LspSession } from './lspSession'
import type { LspPosition, LspRange } from './lspWorkspaceEdit'

export interface DefinitionTarget {
  symbol?: string
  range?: LspRange
}

export interface DefinitionReveal extends DefinitionTarget {
  requestId: number
}

export interface LspExtensionOptions {
  session: LspSession
  path: string
  /** Opens `path` in a tab and reveals the target once it has loaded. */
  onOpenDefinition: (path: string, target: DefinitionTarget) => void
  /** Runs the regex/import-resolution fallback when the server has no answer. */
  onFallbackDefinition: (view: EditorView, pos: number) => void
  /** Hands control to React so the rename dialog can open. */
  onRequestRename: (view: EditorView, pos: number) => void
}

export function offsetToPosition(doc: Text, offset: number): LspPosition {
  const line = doc.lineAt(offset)
  return { line: line.number - 1, character: offset - line.from }
}

export function positionToOffset(doc: Text, position: LspPosition) {
  const lineNumber = Math.min(doc.lines, Math.max(1, position.line + 1))
  const line = doc.line(lineNumber)
  return Math.min(line.to, line.from + Math.max(0, position.character))
}

export function revealRange(view: EditorView, range: LspRange) {
  const anchor = positionToOffset(view.state.doc, range.start)
  const head = positionToOffset(view.state.doc, range.end)
  view.dispatch({ selection: { anchor, head }, scrollIntoView: true })
  view.focus()
}

function symbolAt(view: EditorView, pos: number) {
  const word = view.state.wordAt(pos)
  return word ? view.state.doc.sliceString(word.from, word.to) : undefined
}

/**
 * Completion source that delegates to the package's plugin but leaves room for
 * `completeAnyWord` behind it. The package ships its own
 * `autocompletion({override: [lspSource]})`, which would drop that fallback, so
 * this reimplements its trigger-character logic and is registered at higher
 * precedence.
 */
function lspCompletionSource(): CompletionSource {
  return async (context) => {
    const view = context.view
    if (!view) return null
    const plugin = view.plugin(languageServerPlugin)
    if (!plugin) return null

    const { state, pos, explicit } = context
    const line = state.doc.lineAt(pos)
    const previous = line.text[pos - line.from - 1]
    let triggerKind: CompletionTriggerKind = CompletionTriggerKind.Invoked
    let triggerCharacter: string | undefined

    if (
      !explicit &&
      previous !== undefined &&
      plugin.client.capabilities?.completionProvider?.triggerCharacters?.includes(previous)
    ) {
      triggerKind = CompletionTriggerKind.TriggerCharacter
      triggerCharacter = previous
    }
    if (!explicit && triggerKind === CompletionTriggerKind.Invoked && !context.matchBefore(/\w+$/)) {
      return null
    }

    try {
      return await plugin.requestCompletion(context, offsetToPosition(state.doc, pos), {
        triggerKind,
        triggerCharacter,
      })
    } catch {
      return null
    }
  }
}

async function goToDefinition(view: EditorView, pos: number, options: LspExtensionOptions) {
  const plugin = view.plugin(languageServerPlugin)
  if (!plugin) {
    options.onFallbackDefinition(view, pos)
    return
  }

  const symbol = symbolAt(view, pos)
  let location: { uri: string; range: LspRange } | null | undefined
  try {
    location = (await plugin.requestDefinition(view, offsetToPosition(view.state.doc, pos))) as
      | { uri: string; range: LspRange }
      | null
      | undefined
  } catch {
    options.onFallbackDefinition(view, pos)
    return
  }

  if (!location?.uri) {
    options.onFallbackDefinition(view, pos)
    return
  }
  // The package already moved the selection when the definition is in this
  // document; only cross-file results are left for us to handle.
  if (location.uri === options.session.documentUri(options.path)) return

  const target = options.session.pathFromUri(location.uri)
  if (!target) {
    toast.error('Definition is outside this worktree')
    return
  }
  options.onOpenDefinition(target, { symbol, range: location.range })
}

// `languageServerWithTransport` (codemirror-languageserver@1.22.0,
// dist/index.js ~line 1189) always returns this fixed 7-element array:
// [languageServerPlugin.of(...), hoverTooltip(), autocompletion(),
// documentHighlight(), renameExtension(), keymap.of(jumpToDefinitionKeymap),
// mouseHandler()]. Index 2 is its own `autocompletion({override: [lspSource]})`
// — a *second*, independently configured `autocompletion()` call below would
// register a second `completionConfig` facet input with a different `override`
// array. `@codemirror/state`'s `combineConfig` has no merge function for
// `override` (only defaultKeymap/closeOnBlur/icons/tooltipClass/optionClass/
// addToOptions/filterStrict do), so it throws "Config merge conflict for field
// override" synchronously out of `EditorState.create` the moment both are
// present — crashing every LSP-attached file's editor on mount. The package
// doesn't export its internal `autocompletion()`/`hoverTooltip()`/
// `documentHighlight()` helpers, so hover and document highlight can only be
// kept by reusing this aggregate and dropping the one element that installs
// its own completion config. If codemirror-languageserver is ever upgraded
// past 1.22.0, re-verify this index against dist/index.js before trusting it.
// `lspExtensions.test.ts` pins this: it asserts that dropping this index (and
// only this index) lets an EditorState build, so a package upgrade that moves
// the element fails the suite instead of crashing every editor at runtime.
export const BUNDLED_AUTOCOMPLETION_INDEX = 2

export function lspExtensions(options: LspExtensionOptions): Extension[] {
  const { session, path } = options
  const documentUri = session.documentUri(path)

  const bundled = languageServerWithTransport({
    client: session.client,
    // `transport`, `rootUri` and `workspaceFolders` are required by the option
    // type but unused when `client` is supplied — the package only reads them
    // when it has to construct a client itself.
    transport: session.transport,
    rootUri: session.rootUri,
    workspaceFolders: [{ uri: session.rootUri, name: 'worktree' }],
    documentUri,
    languageId: session.languageId,
    allowHTMLContent: false,
    synchronizationMethod: SynchronizationMethod.Incremental,
  }).filter((_, index) => index !== BUNDLED_AUTOCOMPLETION_INDEX)

  return [
    bundled,

    // The only autocompletion() extension in the tree — registered above
    // everything else so `completeAnyWord` survives as a fallback when the
    // server returns nothing. Prec.high is harmless-but-unnecessary here now
    // that the bundled autocompletion() above is filtered out; kept for
    // clarity alongside the other Prec.high overrides in this file.
    Prec.high(
      autocompletion({
        override: [lspCompletionSource(), completeAnyWord],
      }),
    ),

    // Returning true stops the package's own Ctrl/Cmd-click handler from firing
    // a second, duplicate definition request. preventDefault + focus() must stay
    // in this order: without them a lookup that resolves to "not found" leaves
    // the view permanently unfocused and typing silently goes nowhere.
    Prec.high(
      EditorView.domEventHandlers({
        mousedown(event, view) {
          if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return false
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos === null) return false
          event.preventDefault()
          view.focus()
          void goToDefinition(view, pos, options)
          return true
        },
      }),
    ),

    Prec.high(
      keymap.of([
        {
          key: 'F12',
          preventDefault: true,
          run: (view) => {
            void goToDefinition(view, view.state.selection.main.head, options)
            return true
          },
        },
        {
          key: 'F2',
          preventDefault: true,
          run: (view) => {
            options.onRequestRename(view, view.state.selection.main.head)
            return true
          },
        },
        { key: 'Shift-Alt-f', preventDefault: true, run: formatDocument },
        { key: 'Ctrl-k Ctrl-f', preventDefault: true, run: formatSelection },
      ]),
    ),

    formattingOptions.of({ tabSize: 2, insertSpaces: true }),
  ]
}
