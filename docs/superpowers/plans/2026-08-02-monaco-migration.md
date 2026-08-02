# Monaco Editor Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CodeMirror with Monaco across all six DevDeck editing surfaces, drive LSP through monaco's native `MonacoLspClient` over the existing `/ws/lsp` socket, add a global VS Code mode toggle, and delete every CodeMirror module and package.

**Architecture:** A shared `features/editor/` kit owns Monaco setup, theming, options and model lifecycle with no LSP knowledge. A `features/terminal/lsp/` bridge adapts DevDeck's authenticated `/ws/lsp` socket to monaco's `IMessageTransport`; every DevDeck-specific deviation (control frames, `initialize` rewriting, private request channel, cross-file rename) lives in that transport so `MonacoLspClient` is used unmodified.

**Tech Stack:** React 19, TypeScript (`verbatimModuleSyntax`), Vite 8, Vitest, `monaco-editor@^0.56.0`, `vscode-languageserver-protocol`, Tailwind v4, zustand, TanStack Query.

**Spec:** `docs/superpowers/specs/2026-08-02-monaco-migration-design.md` — read it before Task 1.

## Global Constraints

- **Never** import `monaco-editor/languages/features/*` — the TypeScript feature lazily pulls 12 MB on the first `.ts` model. Only `monaco-editor/editor`, `monaco-editor/features/register.all`, `monaco-editor/languages/definitions/register.all`.
- **Never** import `monaco-editor` (the root entry) — it registers those language features.
- All modules import the monaco namespace from `@/features/editor/monacoSetup`, never from `monaco-editor/editor` directly. This guarantees setup runs exactly once before any use.
- Frontend imports use the `@/*` alias. Never relative paths into `src/`.
- `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Icons: `lucide-react` only. Toasts: `sonner`. Class merging: `cn()` from `@/lib/utils`.
- Design is dark-only; use the `devdeck-*` CSS custom properties from `globals.css`.
- Every new Vitest file MUST be added to the `test.include` array in `frontend/vite.config.ts` in the same commit, or it will not run.
- No test may mount a Monaco editor — jsdom lacks `matchMedia`/`ResizeObserver`/layout. Units under test are pure, or take the monaco namespace as an injected argument.
- `monaco-editor` is pinned `^0.56.0`. Do not upgrade it in this plan.
- Verification gates: `npm run typecheck`, `npm test`, `npm run build` from `frontend/`.
- Commit after every task. Never delete a CodeMirror package before Task 16.

## File Structure

**Created — `frontend/src/features/editor/`** (shared kit, no LSP knowledge)

| File | Responsibility |
|---|---|
| `monacoSetup.ts` | Tree-shaken monaco imports, worker wiring, theme registration; re-exports `monaco` |
| `editorTheme.ts` | `devdeck-dark` theme data |
| `editorOptions.ts` | Pure `vscodeMode` → `IStandaloneEditorConstructionOptions` |
| `useVsCodeMode.ts` | localStorage pref + subscriber fan-out |
| `languageForPath.ts` | Path → monaco language id |
| `modelRegistry.ts` | Ref-counted `ITextModel` cache |
| `reveal.ts` | Line/range reveal helpers |
| `MonacoEditor.tsx` | The single React wrapper + breadcrumb strip |

**Created — `frontend/src/features/terminal/lsp/`**

| File | Responsibility |
|---|---|
| `lspTransport.ts` | Moved from `features/terminal/`, reshaped to `IMessageTransport`, plus `initialize` rewrite and `request()` |
| `lspSession.ts` | Moved, `MonacoLspClient` swapped in |
| `lspWorkspaceEdit.ts` | Moved verbatim |
| `lspRename.ts` | Moved, apply step retargeted |
| `definitionFallback.ts` | Extracted from `CodeFileEditor.tsx` |
| `editorOpener.ts` | `registerEditorOpener` → DevDeck tab |

**Modified:** `vite.config.ts`, `CodeFileEditor.tsx`, `PlainCodeEditor.tsx`, `MarkdownFileEditor.tsx`, `DBSqlEditor.tsx`, `EnvSettingsEditor.tsx`, `SkillContentDialog.tsx`, `DesktopSettingsDialog.tsx`, `package.json`.

**Deleted:** `lspExtensions.ts`, `lspExtensions.test.ts`.

---

### Task 1: Monaco setup, theme and the alias

**Files:**
- Modify: `frontend/vite.config.ts`
- Create: `frontend/src/features/editor/monacoSetup.ts`
- Create: `frontend/src/features/editor/editorTheme.ts`
- Test: `frontend/src/features/editor/monacoLspClient.guard.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `monaco` (the namespace re-export), `DEVDECK_DARK` theme name constant `'devdeck-dark'`

`monaco-editor@^0.56.0` is already installed. Verify with `node -p "require('./package.json').dependencies['monaco-editor']"` from `frontend/`.

- [ ] **Step 1: Write the failing guard test**

Create `frontend/src/features/editor/monacoLspClient.guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

/** monaco exports its native LSP client only from the package root, which also
 *  registers the 12 MB TypeScript language feature. We therefore reach it by
 *  path through a Vite alias. That path is outside monaco's `exports` map, so
 *  this test is the only thing standing between a monaco upgrade and a broken
 *  editor. If it fails, find the new location of MonacoLspClient and update the
 *  alias in vite.config.ts. */
describe('monaco-lsp-client alias', () => {
  it('resolves and exports MonacoLspClient', async () => {
    const mod = await import('monaco-lsp-client')
    expect(typeof mod.MonacoLspClient).toBe('function')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/features/editor/monacoLspClient.guard.test.ts`
Expected: FAIL — `Failed to resolve import "monaco-lsp-client"`.

- [ ] **Step 3: Add the alias and register the test file**

In `frontend/vite.config.ts`, add to `resolve.alias` (keep the existing `'@'` entry):

```ts
      'monaco-lsp-client': fileURLToPath(
        new URL(
          './node_modules/monaco-editor/esm/external/monaco-lsp-client/out/index.js',
          import.meta.url,
        ),
      ),
```

Add to `test.include`:

```ts
      'src/features/editor/monacoLspClient.guard.test.ts',
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/features/editor/monacoLspClient.guard.test.ts`
Expected: PASS

- [ ] **Step 5: Write the theme**

Create `frontend/src/features/editor/editorTheme.ts`. Colours are lifted from the existing
`devdeckCodeTheme` in `CodeFileEditor.tsx` so the editor looks unchanged when VS Code mode is off:

```ts
import type { editor } from 'monaco-editor/editor'

export const DEVDECK_DARK = 'devdeck-dark'

/** Ported from `devdeckCodeTheme` + `oneDark` in the CodeMirror editor so the
 *  surface reads identically after the migration. Monaco token scopes replace
 *  Lezer highlight tags. */
export const devdeckDarkTheme: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '5f6672', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c678dd' },
    { token: 'string', foreground: '98c379' },
    { token: 'number', foreground: 'd19a66' },
    { token: 'type', foreground: 'e5c07b' },
    { token: 'function', foreground: '61afef' },
    { token: 'variable', foreground: 'e06c75' },
    { token: 'operator', foreground: '56b6c2' },
  ],
  colors: {
    'editor.background': '#090a0c',
    'editor.foreground': '#d8d8d4',
    'editorLineNumber.foreground': '#4a5059',
    'editorLineNumber.activeForeground': '#8b939f',
    'editor.lineHighlightBackground': '#11131600',
    'editor.selectionBackground': '#2c313a',
    'editorCursor.foreground': '#d8d8d4',
    'editorIndentGuide.background1': '#1c1f24',
    'editorGutter.background': '#090a0c',
    'editorWidget.background': '#0e1013',
    'editorWidget.border': '#1c1f24',
    'editorSuggestWidget.background': '#0e1013',
    'editorSuggestWidget.border': '#1c1f24',
    'editorSuggestWidget.selectedBackground': '#1c1f24',
    'editorHoverWidget.background': '#0e1013',
    'editorHoverWidget.border': '#1c1f24',
    'minimap.background': '#090a0c',
    'scrollbarSlider.background': '#1c1f2480',
    'scrollbarSlider.hoverBackground': '#2c313a80',
  },
}
```

- [ ] **Step 6: Write the setup module**

Create `frontend/src/features/editor/monacoSetup.ts`:

```ts
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
```

- [ ] **Step 7: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS. If `monaco-editor/editor/editor.worker?worker` fails to resolve, confirm the file exists with `ls node_modules/monaco-editor/esm/vs/editor/editor.worker.js` — the `exports` map rewrites `./editor/*` to `./esm/vs/editor/*`.

- [ ] **Step 8: Commit**

```bash
git add frontend/vite.config.ts frontend/package.json frontend/package-lock.json frontend/src/features/editor/
git commit -m "feat(editor): monaco setup, devdeck-dark theme and LSP client alias"
```

---

### Task 2: Editor options and the VS Code mode pref

**Files:**
- Create: `frontend/src/features/editor/editorOptions.ts`
- Create: `frontend/src/features/editor/useVsCodeMode.ts`
- Test: `frontend/src/features/editor/editorOptions.test.ts`
- Test: `frontend/src/features/editor/useVsCodeMode.test.ts`
- Modify: `frontend/vite.config.ts` (`test.include`)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `buildEditorOptions(vscodeMode: boolean, overrides?: editor.IStandaloneEditorConstructionOptions): editor.IStandaloneEditorConstructionOptions`
  - `VSCODE_MODE_STORAGE_KEY = 'devdeck.editor.vscodeMode'`
  - `readVsCodeMode(): boolean`
  - `setVsCodeMode(next: boolean): void`
  - `subscribeVsCodeMode(listener: (next: boolean) => void): () => void`
  - `useVsCodeMode(): [boolean, (next: boolean) => void]`

- [ ] **Step 1: Write the failing options test**

Create `frontend/src/features/editor/editorOptions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildEditorOptions } from './editorOptions'

describe('buildEditorOptions', () => {
  it('turns on IDE chrome in VS Code mode', () => {
    const options = buildEditorOptions(true)
    expect(options.minimap?.enabled).toBe(true)
    expect(options.stickyScroll?.enabled).toBe(true)
    expect(options.folding).toBe(true)
    expect(options.glyphMargin).toBe(true)
    expect(options.occurrencesHighlight).toBe('singleFile')
    expect(options.renderLineHighlight).toBe('all')
    expect(options.matchBrackets).toBe('always')
  })

  it('stays minimal when VS Code mode is off', () => {
    const options = buildEditorOptions(false)
    expect(options.minimap?.enabled).toBe(false)
    expect(options.stickyScroll?.enabled).toBe(false)
    expect(options.folding).toBe(false)
    expect(options.glyphMargin).toBe(false)
    expect(options.occurrencesHighlight).toBe('off')
    expect(options.renderLineHighlight).toBe('line')
    expect(options.matchBrackets).toBe('near')
  })

  it('keeps line numbers on in both modes', () => {
    expect(buildEditorOptions(true).lineNumbers).toBe('on')
    expect(buildEditorOptions(false).lineNumbers).toBe('on')
  })

  it('lets callers override any option', () => {
    const options = buildEditorOptions(false, { readOnly: true, wordWrap: 'on' })
    expect(options.readOnly).toBe(true)
    expect(options.wordWrap).toBe('on')
    expect(options.minimap?.enabled).toBe(false)
  })
})
```

- [ ] **Step 2: Write the failing pref test**

Create `frontend/src/features/editor/useVsCodeMode.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VSCODE_MODE_STORAGE_KEY,
  readVsCodeMode,
  setVsCodeMode,
  subscribeVsCodeMode,
} from './useVsCodeMode'

describe('vscode mode pref', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to off when nothing is stored', () => {
    expect(readVsCodeMode()).toBe(false)
  })

  it('round-trips through localStorage', () => {
    setVsCodeMode(true)
    expect(localStorage.getItem(VSCODE_MODE_STORAGE_KEY)).toBe('true')
    expect(readVsCodeMode()).toBe(true)
  })

  it('treats a malformed value as off rather than throwing', () => {
    localStorage.setItem(VSCODE_MODE_STORAGE_KEY, '{not json')
    expect(readVsCodeMode()).toBe(false)
  })

  it('notifies subscribers so open editors update live', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeVsCodeMode(listener)
    setVsCodeMode(true)
    expect(listener).toHaveBeenCalledWith(true)
    unsubscribe()
    setVsCodeMode(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd frontend && npx vitest run src/features/editor/editorOptions.test.ts src/features/editor/useVsCodeMode.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `editorOptions.ts`**

```ts
import type { editor } from 'monaco-editor/editor'

/** Pure so the VS Code mode mapping is testable without mounting an editor.
 *  `overrides` wins over both modes — surfaces like the read-only skill viewer
 *  and the word-wrapped markdown editor layer their own options on top. */
export function buildEditorOptions(
  vscodeMode: boolean,
  overrides: editor.IStandaloneEditorConstructionOptions = {},
): editor.IStandaloneEditorConstructionOptions {
  return {
    fontFamily: "'Geist Mono', ui-monospace, monospace",
    fontSize: 12.5,
    lineHeight: 1.5,
    lineNumbers: 'on',
    automaticLayout: true,
    scrollBeyondLastLine: false,
    tabSize: 2,
    insertSpaces: true,
    smoothScrolling: true,
    padding: { top: 8, bottom: 8 },
    scrollbar: { vertical: 'auto', horizontal: 'auto', verticalScrollbarSize: 10 },
    minimap: { enabled: vscodeMode },
    stickyScroll: { enabled: vscodeMode },
    folding: vscodeMode,
    glyphMargin: vscodeMode,
    occurrencesHighlight: vscodeMode ? 'singleFile' : 'off',
    renderLineHighlight: vscodeMode ? 'all' : 'line',
    matchBrackets: vscodeMode ? 'always' : 'near',
    bracketPairColorization: { enabled: vscodeMode },
    guides: { indentation: vscodeMode, bracketPairs: vscodeMode },
    ...overrides,
  }
}
```

- [ ] **Step 5: Implement `useVsCodeMode.ts`**

```ts
import { useCallback, useEffect, useState } from 'react'

export const VSCODE_MODE_STORAGE_KEY = 'devdeck.editor.vscodeMode'

const listeners = new Set<(next: boolean) => void>()

export function readVsCodeMode(): boolean {
  try {
    return window.localStorage.getItem(VSCODE_MODE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function setVsCodeMode(next: boolean) {
  try {
    window.localStorage.setItem(VSCODE_MODE_STORAGE_KEY, String(next))
  } catch {
    // A private-mode / quota failure must not stop the toggle taking effect for
    // this session, so the listeners still fire below.
  }
  for (const listener of listeners) listener(next)
}

export function subscribeVsCodeMode(listener: (next: boolean) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Every mounted editor subscribes, so flipping the setting calls
 *  `editor.updateOptions()` on each one — no remount, no lost undo history. */
export function useVsCodeMode(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState(readVsCodeMode)
  useEffect(() => subscribeVsCodeMode(setEnabled), [])
  return [enabled, useCallback((next: boolean) => setVsCodeMode(next), [])]
}
```

- [ ] **Step 6: Register both test files**

Add to `test.include` in `frontend/vite.config.ts`:

```ts
      'src/features/editor/editorOptions.test.ts',
      'src/features/editor/useVsCodeMode.test.ts',
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/editor/`
Expected: PASS, 3 files.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/editor/ frontend/vite.config.ts
git commit -m "feat(editor): vscode mode options mapping and localStorage pref"
```

---

### Task 3: Language resolution and the model registry

**Files:**
- Create: `frontend/src/features/editor/languageForPath.ts`
- Create: `frontend/src/features/editor/modelRegistry.ts`
- Test: `frontend/src/features/editor/languageForPath.test.ts`
- Test: `frontend/src/features/editor/modelRegistry.test.ts`
- Modify: `frontend/vite.config.ts` (`test.include`)

**Interfaces:**
- Consumes: nothing (both take monaco as an injected argument where needed)
- Produces:
  - `languageForPath(path: string): string`
  - `createModelRegistry(monacoLike: ModelHost)` where
    `ModelHost = { createModel(value: string, language: string, uri: unknown): ModelLike }`
    and `ModelLike = { dispose(): void; getValue(): string; setValue(v: string): void }`
  - Registry methods: `acquire(key, value, language, uri)`, `release(key)`, `get(key)`, `size()`

- [ ] **Step 1: Write the failing language test**

Create `frontend/src/features/editor/languageForPath.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { languageForPath } from './languageForPath'

describe('languageForPath', () => {
  it('maps common source extensions', () => {
    expect(languageForPath('src/main.go')).toBe('go')
    expect(languageForPath('a/b/App.tsx')).toBe('typescript')
    expect(languageForPath('index.ts')).toBe('typescript')
    expect(languageForPath('script.js')).toBe('javascript')
    expect(languageForPath('mod.rs')).toBe('rust')
    expect(languageForPath('main.py')).toBe('python')
    expect(languageForPath('Main.java')).toBe('java')
    expect(languageForPath('q.sql')).toBe('sql')
    expect(languageForPath('notes.md')).toBe('markdown')
    expect(languageForPath('tsconfig.json')).toBe('json')
  })

  it('matches well-known filenames that have no extension', () => {
    expect(languageForPath('Dockerfile')).toBe('dockerfile')
    expect(languageForPath('deep/path/Makefile')).toBe('makefile')
  })

  it('is case-insensitive on the extension', () => {
    expect(languageForPath('README.MD')).toBe('markdown')
  })

  it('falls back to plaintext', () => {
    expect(languageForPath('LICENSE')).toBe('plaintext')
    expect(languageForPath('data.unknownext')).toBe('plaintext')
    expect(languageForPath('')).toBe('plaintext')
  })
})
```

- [ ] **Step 2: Write the failing registry test**

Create `frontend/src/features/editor/modelRegistry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createModelRegistry } from './modelRegistry'

function fakeHost() {
  const created: Array<{ value: string; disposed: boolean }> = []
  return {
    created,
    createModel(value: string) {
      const model = {
        value,
        disposed: false,
        getValue: () => model.value,
        setValue: (v: string) => {
          model.value = v
        },
        dispose: () => {
          model.disposed = true
        },
      }
      created.push(model)
      return model
    },
  }
}

describe('createModelRegistry', () => {
  it('creates a model once and reuses it for the same key', () => {
    const host = fakeHost()
    const registry = createModelRegistry(host)
    const a = registry.acquire('k', 'hello', 'go', 'file:///k')
    const b = registry.acquire('k', 'ignored', 'go', 'file:///k')
    expect(a).toBe(b)
    expect(host.created).toHaveLength(1)
    // The second acquire must NOT clobber live edits with its stale value.
    expect(a.getValue()).toBe('hello')
  })

  it('keeps the model alive while any holder remains', () => {
    const host = fakeHost()
    const registry = createModelRegistry(host)
    const model = registry.acquire('k', 'v', 'go', 'file:///k')
    registry.acquire('k', 'v', 'go', 'file:///k')
    registry.release('k')
    expect(model.disposed).toBe(false)
    expect(registry.size()).toBe(1)
  })

  it('disposes only when the last holder releases', () => {
    const host = fakeHost()
    const registry = createModelRegistry(host)
    const model = registry.acquire('k', 'v', 'go', 'file:///k')
    registry.acquire('k', 'v', 'go', 'file:///k')
    registry.release('k')
    registry.release('k')
    expect(model.disposed).toBe(true)
    expect(registry.size()).toBe(0)
  })

  it('ignores releases beyond zero', () => {
    const host = fakeHost()
    const registry = createModelRegistry(host)
    registry.acquire('k', 'v', 'go', 'file:///k')
    registry.release('k')
    expect(() => registry.release('k')).not.toThrow()
    expect(registry.size()).toBe(0)
  })

  it('survives a pane remount: re-acquiring after a balanced release/acquire pair keeps one model', () => {
    const host = fakeHost()
    const registry = createModelRegistry(host)
    const first = registry.acquire('k', 'v', 'go', 'file:///k')
    registry.acquire('k', 'v', 'go', 'file:///k') // remount acquires before unmount releases
    registry.release('k')
    const second = registry.get('k')
    expect(second).toBe(first)
    expect(host.created).toHaveLength(1)
  })

  it('notifies a dispose listener so the LSP can send didClose', () => {
    const host = fakeHost()
    const registry = createModelRegistry(host)
    const onDispose = vi.fn()
    registry.acquire('k', 'v', 'go', 'file:///k', onDispose)
    registry.release('k')
    expect(onDispose).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd frontend && npx vitest run src/features/editor/languageForPath.test.ts src/features/editor/modelRegistry.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `languageForPath.ts`**

```ts
/** Replaces CodeMirror's `LanguageDescription.matchFilename(languages, path)`.
 *  Monaco's own `languages.getLanguages()` could be queried instead, but that
 *  requires the monaco namespace and therefore a browser; a static table keeps
 *  this pure and unit-testable, and the set of languages DevDeck opens is
 *  well-known. Unlisted extensions fall back to 'plaintext', which still gives
 *  a working editor — just no tokenizer. */
const BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
}

const BY_EXTENSION: Record<string, string> = {
  go: 'go', mod: 'go', sum: 'plaintext',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  rs: 'rust', java: 'java', kt: 'kotlin', scala: 'scala',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', rb: 'ruby', swift: 'swift', dart: 'dart',
  lua: 'lua', r: 'r', pl: 'perl', ex: 'elixir', exs: 'elixir',
  erl: 'erlang', clj: 'clojure', hs: 'plaintext',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', bat: 'bat',
  sql: 'sql',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', env: 'ini',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  graphql: 'graphql', gql: 'graphql', proto: 'proto',
  vue: 'html', svelte: 'html',
  dockerfile: 'dockerfile',
}

export function languageForPath(path: string): string {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  if (!name) return 'plaintext'

  const byName = BY_FILENAME[name]
  if (byName) return byName

  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return BY_EXTENSION[name.slice(dot + 1)] ?? 'plaintext'
}
```

- [ ] **Step 5: Implement `modelRegistry.ts`**

```ts
export interface ModelLike {
  dispose(): void
  getValue(): string
  setValue(value: string): void
}

export interface ModelHost {
  createModel(value: string, language: string, uri: unknown): ModelLike
}

/**
 * Ref-counted cache of Monaco text models, living outside React.
 *
 * `PaneCanvas` remounts the leaf hosting an editor on every drag-to-split or
 * merge (`moveTab` always allocates a fresh leaf id — see paneTree.ts). If the
 * *model* were recreated on each of those remounts, the LSP `didOpen`/
 * `didChange` version counter would reset with no matching `didClose`, which
 * desyncs diagnostics and can make a server reject later `didChange` versions.
 * Keeping models here means a pane restructure recreates only the cheap editor
 * instance and reattaches the same model, preserving undo history too.
 *
 * This mirrors `sshTerminalRegistry.ts`, which keeps xterm sessions outside the
 * component tree for exactly the same reason.
 */
export function createModelRegistry(host: ModelHost) {
  interface Entry {
    model: ModelLike
    refs: number
    onDispose?: () => void
  }
  const entries = new Map<string, Entry>()

  return {
    acquire(
      key: string,
      value: string,
      language: string,
      uri: unknown,
      onDispose?: () => void,
    ): ModelLike {
      const existing = entries.get(key)
      if (existing) {
        // Deliberately does NOT call setValue: `value` is the caller's initial
        // snapshot, which is stale for an already-open buffer with live edits.
        existing.refs += 1
        return existing.model
      }
      const model = host.createModel(value, language, uri)
      entries.set(key, { model, refs: 1, onDispose })
      return model
    },

    release(key: string) {
      const entry = entries.get(key)
      if (!entry) return
      entry.refs -= 1
      if (entry.refs > 0) return
      entries.delete(key)
      entry.onDispose?.()
      entry.model.dispose()
    },

    get(key: string) {
      return entries.get(key)?.model
    },

    size() {
      return entries.size
    },
  }
}
```

- [ ] **Step 6: Register both test files**

Add to `test.include` in `frontend/vite.config.ts`:

```ts
      'src/features/editor/languageForPath.test.ts',
      'src/features/editor/modelRegistry.test.ts',
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/editor/`
Expected: PASS, 5 files.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/editor/ frontend/vite.config.ts
git commit -m "feat(editor): path-to-language table and ref-counted model registry"
```

---

### Task 4: The `MonacoEditor` React wrapper

**Files:**
- Create: `frontend/src/features/editor/reveal.ts`
- Create: `frontend/src/features/editor/MonacoEditor.tsx`
- Test: `frontend/src/features/editor/reveal.test.ts`
- Modify: `frontend/vite.config.ts` (`test.include`)

**Interfaces:**
- Consumes: `setupMonaco`/`monaco` (Task 1), `buildEditorOptions`/`useVsCodeMode` (Task 2), `languageForPath`/`createModelRegistry` (Task 3)
- Produces:
  - `export interface LineReveal { line: number; column?: number }`
  - `export interface RangeReveal { startLine: number; startColumn: number; endLine: number; endColumn: number }`
  - `export type EditorReveal = LineReveal | RangeReveal`
  - `export function toMonacoRange(reveal: EditorReveal, lineCount: number, lineMaxColumn: (line: number) => number): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }`
  - `export function MonacoEditor(props: MonacoEditorProps): JSX.Element` with props
    `{ path: string; value: string; onChange?: (value: string) => void; ready?: boolean; reveal?: EditorReveal; readOnly?: boolean; language?: string; modelKey?: string; options?: editor.IStandaloneEditorConstructionOptions; onMount?: (editor: editor.IStandaloneCodeEditor) => void | (() => void); ariaLabel?: string; className?: string }`

`LineReveal` keeps the exact shape exported today by `PlainCodeEditor.tsx` so `SSHShellPane.tsx`,
`SSHFileEditor.tsx`, `FileEditor.tsx` and `ContentSearchPanel.tsx` keep compiling.

- [ ] **Step 1: Write the failing reveal test**

Create `frontend/src/features/editor/reveal.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { toMonacoRange } from './reveal'

const maxColumn = (line: number) => 10 + line

describe('toMonacoRange', () => {
  it('converts a line reveal to a collapsed range at that line', () => {
    const range = toMonacoRange({ line: 3 }, 100, maxColumn)
    expect(range).toEqual({
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 1,
    })
  })

  it('honours an explicit column', () => {
    const range = toMonacoRange({ line: 3, column: 5 }, 100, maxColumn)
    expect(range.startColumn).toBe(5)
    expect(range.endColumn).toBe(5)
  })

  it('passes a full range through', () => {
    const range = toMonacoRange(
      { startLine: 2, startColumn: 3, endLine: 4, endColumn: 7 },
      100,
      maxColumn,
    )
    expect(range).toEqual({
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 4,
      endColumn: 7,
    })
  })

  it('clamps a line past the end of the document', () => {
    const range = toMonacoRange({ line: 500 }, 10, maxColumn)
    expect(range.startLineNumber).toBe(10)
  })

  it('clamps a column past the end of its line', () => {
    // maxColumn(2) === 12
    const range = toMonacoRange({ line: 2, column: 999 }, 10, maxColumn)
    expect(range.startColumn).toBe(12)
  })

  it('clamps a non-positive line to the first line', () => {
    const range = toMonacoRange({ line: 0 }, 10, maxColumn)
    expect(range.startLineNumber).toBe(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/features/editor/reveal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `reveal.ts`**

```ts
/** Content search's "open at line" entry point. 1-based line and column, matching
 *  both ripgrep's output and Monaco's own coordinate system. Kept structurally
 *  identical to the interface `PlainCodeEditor.tsx` exports today so existing
 *  callers in SSHShellPane, SSHFileEditor, FileEditor and ContentSearchPanel
 *  need no changes. */
export interface LineReveal {
  line: number
  column?: number
}

/** A definition jump or an LSP range result. */
export interface RangeReveal {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export type EditorReveal = LineReveal | RangeReveal

export function isRangeReveal(reveal: EditorReveal): reveal is RangeReveal {
  return 'startLine' in reveal
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

/** Pure so the clamping is testable without an editor. A stale reveal can point
 *  past the end of a document that has since shrunk; clamping keeps that a
 *  no-op scroll rather than a thrown range error. */
export function toMonacoRange(
  reveal: EditorReveal,
  lineCount: number,
  lineMaxColumn: (line: number) => number,
) {
  if (isRangeReveal(reveal)) {
    const startLineNumber = clamp(reveal.startLine, 1, lineCount)
    const endLineNumber = clamp(reveal.endLine, 1, lineCount)
    return {
      startLineNumber,
      startColumn: clamp(reveal.startColumn, 1, lineMaxColumn(startLineNumber)),
      endLineNumber,
      endColumn: clamp(reveal.endColumn, 1, lineMaxColumn(endLineNumber)),
    }
  }
  const line = clamp(reveal.line, 1, lineCount)
  const column = clamp(reveal.column ?? 1, 1, lineMaxColumn(line))
  return {
    startLineNumber: line,
    startColumn: column,
    endLineNumber: line,
    endColumn: column,
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/features/editor/reveal.test.ts`
Expected: PASS

- [ ] **Step 5: Implement `MonacoEditor.tsx`**

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor/editor'
import { monaco, setupMonaco } from './monacoSetup'
import { buildEditorOptions } from './editorOptions'
import { useVsCodeMode } from './useVsCodeMode'
import { languageForPath } from './languageForPath'
import { createModelRegistry } from './modelRegistry'
import { toMonacoRange, type EditorReveal } from './reveal'
import { cn } from '@/lib/utils'

setupMonaco()

/** One registry for the whole app — see modelRegistry.ts for why models must
 *  outlive the React components that display them. */
const models = createModelRegistry({
  createModel: (value, language, uri) =>
    monaco.editor.createModel(value, language, uri as monaco.Uri),
})

export interface MonacoEditorProps {
  path: string
  value: string
  onChange?: (value: string) => void
  /** True once `value` is the file's real, loaded content rather than the empty
   *  placeholder rendered while a fetch is in flight. The reveal effect gates on
   *  this rather than on `value` — see the effect below. */
  ready?: boolean
  reveal?: EditorReveal
  readOnly?: boolean
  language?: string
  /** Stable identity for the underlying model. Defaults to `path`; worktree and
   *  SSH surfaces pass `machine:worktree:path` so two machines can have the same
   *  relative path open at once. */
  modelKey?: string
  options?: editor.IStandaloneEditorConstructionOptions
  /** Runs once the editor instance exists. May return a cleanup function — this
   *  is where LSP wiring, custom actions and keybindings attach. */
  onMount?: (instance: editor.IStandaloneCodeEditor) => void | (() => void)
  ariaLabel?: string
  className?: string
}

export function MonacoEditor({
  path,
  value,
  onChange,
  ready = true,
  reveal,
  readOnly = false,
  language,
  modelKey,
  options,
  onMount,
  ariaLabel,
  className,
}: MonacoEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const [vscodeMode] = useVsCodeMode()
  // Monaco builds its instance inside a layout effect, so on a freshly mounted
  // tab `editorRef.current` is still null when the reveal effect below first
  // runs. Bumping this once the instance exists re-runs that effect, rather than
  // relying on an incidental extra render.
  const [mounted, setMounted] = useState(false)

  const key = modelKey ?? path
  const resolvedLanguage = language ?? languageForPath(path)

  // Latest-value refs: the mount effect must run exactly once per key, so it
  // cannot close over props that change on every keystroke.
  const latest = useRef({ onChange, onMount, options, vscodeMode, readOnly })
  useEffect(() => {
    latest.current = { onChange, onMount, options, vscodeMode, readOnly }
  })

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const uri = monaco.Uri.parse(`inmemory://devdeck/${encodeURI(key)}`)
    const model = models.acquire(key, value, resolvedLanguage, uri)

    const instance = monaco.editor.create(host, {
      ...buildEditorOptions(latest.current.vscodeMode, latest.current.options),
      readOnly: latest.current.readOnly,
      model: model as editor.ITextModel,
    })
    editorRef.current = instance
    setMounted(true)

    const changeSub = instance.onDidChangeModelContent(() => {
      latest.current.onChange?.(instance.getValue())
    })
    const cleanupMount = latest.current.onMount?.(instance)

    return () => {
      if (typeof cleanupMount === 'function') cleanupMount()
      changeSub.dispose()
      editorRef.current = null
      setMounted(false)
      // Dispose the instance but NOT the model — release() decides that.
      instance.dispose()
      models.release(key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, resolvedLanguage])

  // Controlled-value sync. Guarded on inequality so echoing our own onChange
  // back in does not reset the cursor on every keystroke.
  useEffect(() => {
    const instance = editorRef.current
    if (!instance) return
    if (instance.getValue() !== value) instance.setValue(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  useEffect(() => {
    editorRef.current?.updateOptions({
      ...buildEditorOptions(vscodeMode, options),
      readOnly,
    })
  }, [vscodeMode, options, readOnly])

  // Deps are [reveal, ready, mounted], NOT [reveal, value]. `ready` flips
  // false->true exactly once, when the file's real content finishes loading, and
  // never changes again for the life of this tab, whereas `value` changes on
  // every keystroke. Depending on `value` re-runs this effect after every edit —
  // re-selecting reveal's range and re-focusing — because `reveal` is never
  // cleared once a search or definition jump has fired. That snapped the cursor
  // back to the searched location on every keystroke, making it look like only
  // that location could be edited.
  useEffect(() => {
    const instance = editorRef.current
    if (!instance || !reveal || !ready) return
    const model = instance.getModel()
    if (!model) return
    const range = toMonacoRange(reveal, model.getLineCount(), (line) =>
      model.getLineMaxColumn(line),
    )
    instance.setSelection(range)
    instance.revealRangeInCenter(range)
    instance.focus()
  }, [reveal, ready, mounted])

  return (
    <div className={cn('flex h-full min-h-0 flex-1 flex-col overflow-hidden', className)}>
      {vscodeMode ? <Breadcrumbs path={path} /> : null}
      <div
        ref={hostRef}
        aria-label={ariaLabel ?? `Edit ${path}`}
        className="min-h-0 flex-1"
      />
    </div>
  )
}

/** Breadcrumbs are workbench UI, not a standalone-editor feature, so DevDeck
 *  renders its own. Display-only by design — clicking a segment is out of scope. */
function Breadcrumbs({ path }: { path: string }) {
  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0) return null
  return (
    <div className="flex flex-none items-center gap-1 overflow-hidden border-b border-devdeck-border bg-devdeck-surface-2 px-3 py-1 font-mono text-[10.5px] text-devdeck-dim">
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1">
          {index > 0 ? <span className="text-devdeck-muted-2">›</span> : null}
          <span className={cn('truncate', index === segments.length - 1 && 'text-devdeck-muted')}>
            {segment}
          </span>
        </span>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Register the reveal test and typecheck**

Add to `test.include` in `frontend/vite.config.ts`:

```ts
      'src/features/editor/reveal.test.ts',
```

Run: `cd frontend && npm run typecheck && npx vitest run src/features/editor/`
Expected: typecheck PASS, 6 test files PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/editor/ frontend/vite.config.ts
git commit -m "feat(editor): MonacoEditor wrapper with reveal latch and breadcrumbs"
```

---

### Task 5: Move the LSP modules and reshape the transport

**Files:**
- Create: `frontend/src/features/terminal/lsp/lspTransport.ts` (moved from `frontend/src/features/terminal/lspTransport.ts`)
- Create: `frontend/src/features/terminal/lsp/lspTransport.test.ts` (moved)
- Test: `frontend/src/features/terminal/lsp/lspTransport.initialize.test.ts`
- Test: `frontend/src/features/terminal/lsp/lspTransport.request.test.ts`
- Modify: `frontend/vite.config.ts` (`test.include`)

**Interfaces:**
- Consumes: `machineWsUrl` from `@/lib/machineClient`
- Produces:
  - `class DevDeckLspTransport` implementing monaco's `IMessageTransport`: `state`, `send(message)`, `setListener(listener)`, `toString()`
  - plus DevDeck additions: `ready: Promise<{rootUri: string}>`, `onStatus(listener)`, `getStatus()`, `getStatusMessage()`, `request<T>(method, params)`, `close()`
  - `openLspTransport(machine, worktreeId, language): Promise<DevDeckLspTransport>`
  - `export type LspStatus = 'connecting' | 'installing' | 'ready' | 'error'`
  - `export function rewriteInitialize(message: RpcMessage, rootUri: string): RpcMessage`

Use `git mv` so history follows the files. The existing `lspTransport.test.ts` must keep passing
unchanged apart from its import path — it pins the control-frame handling, the send queue, the `id: 0`
guard and the `workspace/configuration` array shape.

- [ ] **Step 1: Move the files**

```bash
cd frontend/src/features/terminal
mkdir -p lsp
git mv lspTransport.ts lsp/lspTransport.ts
git mv lspTransport.test.ts lsp/lspTransport.test.ts
git mv lspSession.ts lsp/lspSession.ts
git mv lspSession.test.ts lsp/lspSession.test.ts
git mv lspWorkspaceEdit.ts lsp/lspWorkspaceEdit.ts
git mv lspWorkspaceEdit.test.ts lsp/lspWorkspaceEdit.test.ts
git mv lspRename.ts lsp/lspRename.ts
```

Update the four `test.include` paths in `frontend/vite.config.ts` from
`src/features/terminal/lspX.test.ts` to `src/features/terminal/lsp/lspX.test.ts`, and fix the relative
imports inside the moved files (`./lspTransport` → still `./lspTransport`; `@/…` imports are unaffected).

Run: `cd frontend && npx vitest run src/features/terminal/lsp/`
Expected: PASS — the moved tests still pass. `lspExtensions.test.ts` will now fail to resolve
`./lspSession`; fix its import to `./lsp/lspSession` for now. It is deleted in Task 16.

- [ ] **Step 2: Write the failing initialize-rewrite test**

Create `frontend/src/features/terminal/lsp/lspTransport.initialize.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { rewriteInitialize } from './lspTransport'

const ROOT = 'file:///home/dev/worktrees/abc'

describe('rewriteInitialize', () => {
  it('injects rootUri and workspaceFolders into an initialize request', () => {
    const out = rewriteInitialize(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: null } },
      ROOT,
    )
    const params = out.params as Record<string, unknown>
    expect(params.rootUri).toBe(ROOT)
    expect(params.workspaceFolders).toEqual([{ uri: ROOT, name: 'worktree' }])
  })

  it('preserves capabilities and every other param monaco sent', () => {
    const capabilities = { textDocument: { completion: {} } }
    const out = rewriteInitialize(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, capabilities } },
      ROOT,
    )
    const params = out.params as Record<string, unknown>
    expect(params.capabilities).toEqual(capabilities)
    expect(params.processId).toBeNull()
  })

  it('leaves every other method untouched', () => {
    const message = { jsonrpc: '2.0' as const, method: 'textDocument/didOpen', params: { a: 1 } }
    expect(rewriteInitialize(message, ROOT)).toBe(message)
  })

  it('tolerates a missing params object', () => {
    const out = rewriteInitialize({ jsonrpc: '2.0', id: 1, method: 'initialize' }, ROOT)
    expect((out.params as Record<string, unknown>).rootUri).toBe(ROOT)
  })
})
```

- [ ] **Step 3: Write the failing private-request test**

Create `frontend/src/features/terminal/lsp/lspTransport.request.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { DevDeckLspTransport } from './lspTransport'

/** Minimal WebSocket stand-in: records what was sent and lets a test push
 *  frames back. Mirrors the fake in lspTransport.test.ts. */
function fakeSocket() {
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const sent: string[] = []
  return {
    readyState: 1,
    sent,
    addEventListener(type: string, handler: (event: unknown) => void) {
      const bucket = listeners.get(type) ?? []
      bucket.push(handler)
      listeners.set(type, bucket)
    },
    send(data: string) {
      sent.push(data)
    },
    close() {
      this.readyState = 3
      for (const handler of listeners.get('close') ?? []) handler({})
    },
    emit(data: unknown) {
      for (const handler of listeners.get('message') ?? []) handler({ data: JSON.stringify(data) })
    },
  }
}

function ready(socket: ReturnType<typeof fakeSocket>) {
  socket.emit({ devdeckLsp: { type: 'ready', rootUri: 'file:///root' } })
}

describe('DevDeckLspTransport.request', () => {
  it('sends a request with a devdeck-prefixed id', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    ready(socket)
    void transport.request('textDocument/rename', { newName: 'x' })
    const message = JSON.parse(socket.sent.at(-1) as string)
    expect(String(message.id).startsWith('devdeck-')).toBe(true)
    expect(message.method).toBe('textDocument/rename')
  })

  it('resolves with the result and never forwards it to the client listener', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    const listener = vi.fn()
    transport.setListener(listener)
    ready(socket)

    const pending = transport.request<{ ok: boolean }>('textDocument/rename', {})
    const id = JSON.parse(socket.sent.at(-1) as string).id
    socket.emit({ jsonrpc: '2.0', id, result: { ok: true } })

    await expect(pending).resolves.toEqual({ ok: true })
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects when the server returns an error', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    ready(socket)
    const pending = transport.request('textDocument/rename', {})
    const id = JSON.parse(socket.sent.at(-1) as string).id
    socket.emit({ jsonrpc: '2.0', id, error: { code: -32600, message: 'nope' } })
    await expect(pending).rejects.toThrow('nope')
  })

  it('forwards responses that are not ours to the client listener', () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    const listener = vi.fn()
    transport.setListener(listener)
    ready(socket)
    socket.emit({ jsonrpc: '2.0', id: 7, result: { fromMonaco: true } })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rejects everything still pending when the socket closes', async () => {
    const socket = fakeSocket()
    const transport = new DevDeckLspTransport(socket as unknown as WebSocket)
    ready(socket)
    const pending = transport.request('textDocument/rename', {})
    socket.close()
    await expect(pending).rejects.toThrow()
  })
})
```

- [ ] **Step 4: Run both to verify they fail**

Run: `cd frontend && npx vitest run src/features/terminal/lsp/lspTransport.initialize.test.ts src/features/terminal/lsp/lspTransport.request.test.ts`
Expected: FAIL — `rewriteInitialize` is not exported; `request` is not a function.

- [ ] **Step 5: Reshape the transport**

Edit `frontend/src/features/terminal/lsp/lspTransport.ts`:

1. Delete `import type { Transport } from 'codemirror-languageserver'` and change the class declaration to
   `export class DevDeckLspTransport implements IMessageTransport` where `IMessageTransport` is a local
   structural interface (do **not** import it from the alias — that would pull monaco into a pure module):

```ts
/** Structural copy of monaco's `lsp.IMessageTransport`. Declared locally rather
 *  than imported so this module — and its tests — stay free of monaco, which
 *  needs a real browser. `monacoLspClient.guard.test.ts` pins the alias itself;
 *  a mismatch here surfaces as a typecheck error at the construction site. */
interface IValueWithChangeEvent<T> {
  readonly value: T
  onChange(listener: (value: T) => void): { dispose(): void }
}
type ConnectionState =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'closed'; error: Error | undefined }
interface IMessageTransport {
  readonly state: IValueWithChangeEvent<ConnectionState>
  send(message: unknown): Promise<void>
  setListener(listener: ((message: unknown) => void) | undefined): void
  toString(): string
}
```

2. Replace the `messageListeners` set with a single `listener` slot and implement `setListener`.
   Monaco's client sets exactly one listener; keeping a set would silently double-deliver.

3. Change `send` to accept a message **object** (monaco sends objects, not strings), run it through
   `rewriteInitialize`, then `JSON.stringify` before writing to the socket. The queue holds objects now.

4. Add a `state` field backed by a tiny value-with-change-event, moving `connecting` → `open` on the
   socket's `open` event and → `closed` on close/error.

5. Add `rewriteInitialize` as an exported pure function:

```ts
export function rewriteInitialize(message: RpcMessage, rootUri: string): RpcMessage {
  if (message.method !== 'initialize') return message
  // MonacoLspClient hardcodes `rootUri: null` and sends no workspaceFolders,
  // which drops gopls into single-file mode. The backend already told us the
  // real root in its `ready` control frame, so patch it in transit rather than
  // patching or subclassing the client.
  return {
    ...message,
    params: {
      ...(message.params as Record<string, unknown> | undefined),
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'worktree' }],
    },
  }
}
```

6. Add the private request channel:

```ts
  private readonly pending = new Map<string, {
    resolve: (value: never) => void
    reject: (error: Error) => void
  }>()
  private nextRequestId = 0

  /** A second JSON-RPC caller on the same socket, alongside MonacoLspClient.
   *  Ids are strings prefixed `devdeck-`, so they cannot collide with the
   *  numeric ids the client allocates; responses carrying one are resolved here
   *  and never forwarded. This is how DevDeck drives cross-file rename, which
   *  the client's own rename feature cannot do (it applies edits only to models
   *  that are already loaded). */
  request<T>(method: string, params: unknown): Promise<T> {
    const id = `devdeck-${this.nextRequestId++}`
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
      })
      void this.send({ jsonrpc: '2.0', id, method, params })
    })
  }
```

In `handleMessage`, before forwarding, check for a response whose `id` is a string starting with
`devdeck-`: resolve or reject the pending entry and return. In `handleClose`, reject every pending entry
with the close error and clear the map.

- [ ] **Step 6: Register both tests and run the whole lsp suite**

Add to `test.include`:

```ts
      'src/features/terminal/lsp/lspTransport.initialize.test.ts',
      'src/features/terminal/lsp/lspTransport.request.test.ts',
```

Run: `cd frontend && npx vitest run src/features/terminal/lsp/`
Expected: PASS — including the pre-existing `lspTransport.test.ts` and `lspWorkspaceEdit.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/terminal frontend/vite.config.ts
git commit -m "refactor(lsp): move modules under lsp/ and reshape transport for monaco"
```

---

### Task 6: Session over `MonacoLspClient`

**Files:**
- Modify: `frontend/src/features/terminal/lsp/lspSession.ts`
- Create: `frontend/src/features/terminal/lsp/monacoLspClient.d.ts`
- Test: `frontend/src/features/terminal/lsp/lspSession.test.ts` (exists — must stay green)

**Interfaces:**
- Consumes: `DevDeckLspTransport`, `openLspTransport` (Task 5)
- Produces: `LspSession` with `{ transport, rootUri, languageId, documentUri, pathFromUri, getStatus, getStatusMessage, subscribeStatus, dispose }` — the `client` field changes type from `LanguageServerClient` to `MonacoLspClient`. `acquireLspSession(machine, worktreeId, languageId)` is unchanged.

- [ ] **Step 1: Declare the alias module's types**

Create `frontend/src/features/terminal/lsp/monacoLspClient.d.ts`:

```ts
/** Types for the `monaco-lsp-client` Vite alias (see vite.config.ts). Monaco
 *  exports this client only from its root entry, which would drag in the 12 MB
 *  TypeScript language feature, so it is imported by path instead. */
declare module 'monaco-lsp-client' {
  export class MonacoLspClient {
    constructor(transport: {
      readonly state: unknown
      send(message: unknown): Promise<void>
      setListener(listener: ((message: unknown) => void) | undefined): void
      toString(): string
    })
  }
}
```

- [ ] **Step 2: Run the existing session test to confirm the baseline**

Run: `cd frontend && npx vitest run src/features/terminal/lsp/lspSession.test.ts`
Expected: PASS (it currently exercises the pool and URI helpers, neither of which changes).

- [ ] **Step 3: Swap the client**

In `lspSession.ts`:

1. Replace `import { LanguageServerClient } from 'codemirror-languageserver'` with
   `import { MonacoLspClient } from 'monaco-lsp-client'`.
2. Change the `LspSession` interface's `client` field to `readonly client: MonacoLspClient`.
3. Replace the `new LanguageServerClient({...})` call with:

```ts
  // Constructing the client immediately sends `initialize`; the transport
  // rewrites it in transit to carry the real rootUri. One client per session,
  // and the pool guarantees one session per machine:worktree:language — monaco's
  // provider registry is keyed by language, not by editor, so a client per
  // editor instance would fan out duplicate completions across split panes.
  const client = new MonacoLspClient(transport)
```

4. In `dispose()`, replace `client.close()` with `transport.close()` only — `MonacoLspClient` exposes no
   `close`; dropping the transport closes the socket, and the providers it registered are per-language
   and harmless once the socket is gone. Keep `unsubscribe()` and `listeners.clear()`.

- [ ] **Step 4: Run the session test to verify it still passes**

Run: `cd frontend && npx vitest run src/features/terminal/lsp/ && cd frontend && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/terminal/lsp/
git commit -m "feat(lsp): drive the session through monaco's native LSP client"
```

---

### Task 7: Definition fallback and the editor opener

**Files:**
- Create: `frontend/src/features/terminal/lsp/definitionFallback.ts`
- Create: `frontend/src/features/terminal/lsp/editorOpener.ts`
- Test: `frontend/src/features/terminal/lsp/definitionFallback.test.ts`
- Test: `frontend/src/features/terminal/lsp/editorOpener.test.ts`
- Modify: `frontend/vite.config.ts` (`test.include`)

**Interfaces:**
- Consumes: `searchWorktreeFiles` from `@/lib/machineApi`, `uriHelpers` from `./lspSession`
- Produces:
  - `findDefinition(source: string, symbol: string): { from: number; to: number } | null`
  - `findImportedSource(source: string, symbol: string): { source: string; revealSymbol: string } | null`
  - `quotedPathAt(source: string, position: number): string | null`
  - `resolveImportBase(currentPath: string, source: string): string | null`
  - `resolveImportFile(machine, worktreeId, currentPath, source): Promise<string | null>`
  - `offsetToLineColumn(source: string, offset: number): { line: number; column: number }`
  - `createEditorOpener(args: { pathFromUri: (uri: string) => string | null; openPath: (path: string, reveal?: RangeReveal) => void }): (uri: string, range?: {startLineNumber:number;startColumn:number;endLineNumber:number;endColumn:number}) => boolean`

Move `findDefinition`, `findImportedSource`, `quotedPathAt`, `resolveImportBase`, `resolveImportFile`,
`normalizeWorkspacePath`, `escapeRegex`, `identifierRegex` and `candidateExtensions` out of
`CodeFileEditor.tsx` **unchanged**. They already operate on strings.

- [ ] **Step 1: Write the failing fallback test**

Create `frontend/src/features/terminal/lsp/definitionFallback.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  findDefinition,
  findImportedSource,
  quotedPathAt,
  resolveImportBase,
} from './definitionFallback'

describe('findDefinition', () => {
  it('finds a function declaration', () => {
    const source = 'const a = 1\nfunction target() {}\n'
    const found = findDefinition(source, 'target')
    expect(source.slice(found!.from, found!.to)).toBe('target')
  })

  it('finds a Go func with a receiver', () => {
    const source = 'func (s *Server) Handle() {}\n'
    const found = findDefinition(source, 'Handle')
    expect(source.slice(found!.from, found!.to)).toBe('Handle')
  })

  it('finds a type declaration', () => {
    const source = 'interface Widget { a: number }\n'
    expect(findDefinition(source, 'Widget')).not.toBeNull()
  })

  it('returns null for an unknown symbol', () => {
    expect(findDefinition('const a = 1', 'missing')).toBeNull()
  })

  it('rejects a symbol that is not an identifier', () => {
    expect(findDefinition('const a = 1', 'a b')).toBeNull()
  })
})

describe('findImportedSource', () => {
  it('finds the module a symbol was imported from', () => {
    const source = "import { Widget } from './widget'\n"
    expect(findImportedSource(source, 'Widget')).toEqual({
      source: './widget',
      revealSymbol: 'Widget',
    })
  })

  it('resolves an aliased import back to its original name', () => {
    const source = "import { Inner as Outer } from './inner'\n"
    expect(findImportedSource(source, 'Outer')).toEqual({
      source: './inner',
      revealSymbol: 'Inner',
    })
  })

  it('handles require()', () => {
    const source = "const fs = require('node:fs')\n"
    expect(findImportedSource(source, 'fs')?.source).toBe('node:fs')
  })

  it('returns null when the symbol was not imported', () => {
    expect(findImportedSource("import { A } from './a'", 'B')).toBeNull()
  })
})

describe('quotedPathAt', () => {
  it('returns the quoted string under the cursor', () => {
    const source = "import x from './target'\n"
    const position = source.indexOf('target')
    expect(quotedPathAt(source, position)).toBe('./target')
  })

  it('returns null when the cursor is outside any quoted string', () => {
    const source = "import x from './target'\n"
    expect(quotedPathAt(source, 2)).toBeNull()
  })
})

describe('resolveImportBase', () => {
  it('resolves the @/ alias to src/', () => {
    expect(resolveImportBase('src/a/b.ts', '@/lib/util')).toBe('src/lib/util')
  })

  it('resolves a relative sibling', () => {
    expect(resolveImportBase('src/a/b.ts', './c')).toBe('src/a/c')
  })

  it('resolves a relative parent', () => {
    expect(resolveImportBase('src/a/b.ts', '../c')).toBe('src/c')
  })

  it('strips a query string', () => {
    expect(resolveImportBase('src/a/b.ts', './c?raw')).toBe('src/a/c')
  })

  it('returns null for a bare package specifier', () => {
    expect(resolveImportBase('src/a/b.ts', 'react')).toBeNull()
  })
})
```

- [ ] **Step 2: Write the failing opener test**

Create `frontend/src/features/terminal/lsp/editorOpener.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createEditorOpener } from './editorOpener'

const pathFromUri = (uri: string) =>
  uri.startsWith('file:///root/') ? uri.slice('file:///root/'.length) : null

describe('createEditorOpener', () => {
  it('opens an in-worktree uri as a DevDeck tab and claims the navigation', () => {
    const openPath = vi.fn()
    const opener = createEditorOpener({ pathFromUri, openPath })
    const handled = opener('file:///root/src/main.go', {
      startLineNumber: 4,
      startColumn: 2,
      endLineNumber: 4,
      endColumn: 9,
    })
    expect(handled).toBe(true)
    expect(openPath).toHaveBeenCalledWith('src/main.go', {
      startLine: 4,
      startColumn: 2,
      endLine: 4,
      endColumn: 9,
    })
  })

  it('opens without a reveal when monaco supplies no range', () => {
    const openPath = vi.fn()
    const opener = createEditorOpener({ pathFromUri, openPath })
    expect(opener('file:///root/a.ts')).toBe(true)
    expect(openPath).toHaveBeenCalledWith('a.ts', undefined)
  })

  it('declines a uri outside the worktree so monaco can fall back', () => {
    const openPath = vi.fn()
    const opener = createEditorOpener({ pathFromUri, openPath })
    expect(opener('file:///elsewhere/x.go')).toBe(false)
    expect(openPath).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd frontend && npx vitest run src/features/terminal/lsp/definitionFallback.test.ts src/features/terminal/lsp/editorOpener.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Create `definitionFallback.ts`**

Cut lines from `CodeFileEditor.tsx` — `candidateExtensions`, `escapeRegex`, `identifierRegex`,
`normalizeWorkspacePath`, `resolveImportBase`, `resolveImportFile`, `findDefinition`,
`findImportedSource`, `quotedPathAt` — into the new module and `export` each of
`findDefinition`, `findImportedSource`, `quotedPathAt`, `resolveImportBase`, `resolveImportFile`.
Add `offsetToLineColumn`:

```ts
/** The fallback heuristics work in string offsets; Monaco addresses everything
 *  in 1-based line/column. */
export function offsetToLineColumn(source: string, offset: number) {
  const clamped = Math.max(0, Math.min(offset, source.length))
  const before = source.slice(0, clamped)
  const line = before.split('\n').length
  const column = clamped - (before.lastIndexOf('\n') + 1) + 1
  return { line, column }
}
```

- [ ] **Step 5: Create `editorOpener.ts`**

```ts
import type { RangeReveal } from '@/features/editor/reveal'

interface MonacoRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

/**
 * Backs `monaco.editor.registerEditorOpener`, monaco's supported hook for
 * "go to definition resolved to a different file".
 *
 * Without it, standalone monaco does nothing at all for a model it does not
 * already have — which is how the previous integration lost cross-file
 * navigation. Returning `true` claims the navigation; returning `false` lets
 * monaco fall back, which is the right answer for a uri outside this worktree
 * (a stdlib or module-cache path the runtime resolved but DevDeck cannot open).
 */
export function createEditorOpener({
  pathFromUri,
  openPath,
}: {
  pathFromUri: (uri: string) => string | null
  openPath: (path: string, reveal?: RangeReveal) => void
}) {
  return (uri: string, range?: MonacoRange): boolean => {
    const path = pathFromUri(uri)
    if (!path) return false
    openPath(
      path,
      range
        ? {
            startLine: range.startLineNumber,
            startColumn: range.startColumn,
            endLine: range.endLineNumber,
            endColumn: range.endColumn,
          }
        : undefined,
    )
    return true
  }
}
```

- [ ] **Step 6: Register both tests, run, typecheck**

Add to `test.include`:

```ts
      'src/features/terminal/lsp/definitionFallback.test.ts',
      'src/features/terminal/lsp/editorOpener.test.ts',
```

Run: `cd frontend && npx vitest run src/features/terminal/lsp/ && npm run typecheck`
Expected: tests PASS. Typecheck will fail in `CodeFileEditor.tsx` for the moved symbols — add
`import { ... } from './lsp/definitionFallback'` there to resolve, then re-run.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/terminal frontend/vite.config.ts
git commit -m "feat(lsp): extract definition fallback heuristics and add editor opener"
```

---

### Task 8: Retarget the rename pipeline to Monaco

**Files:**
- Modify: `frontend/src/features/terminal/lsp/lspRename.ts`
- Test: `frontend/src/features/terminal/lsp/lspWorkspaceEdit.test.ts` (exists — must stay green)

**Interfaces:**
- Consumes: `DevDeckLspTransport.request` (Task 5), `LspSession` (Task 6), `splitWorkspaceEdit` from `./lspWorkspaceEdit`
- Produces:
  - `prepareRename(session, path, model, position): Promise<RenameSubject | null>`
  - `buildRenamePlan({ session, path, subject, newName, isPathDirty }): Promise<{ ok: true; plan: RenamePlan } | { ok: false; reason: string }>`
  - `applyRenamePlan({ model, plan, machine, worktreeId, queryClient }): Promise<void>`

`RenameSubject` and `RenamePlan` keep their existing shapes so `RenameSymbolDialog.tsx` needs no change.

- [ ] **Step 1: Confirm the workspace-edit baseline**

Run: `cd frontend && npx vitest run src/features/terminal/lsp/lspWorkspaceEdit.test.ts`
Expected: PASS — this module is pure and does not change.

- [ ] **Step 2: Replace the CodeMirror plumbing**

In `lspRename.ts`:

1. Delete `import type { EditorView } from '@codemirror/view'` and the
   `import { offsetToPosition, positionToOffset } from './lspExtensions'` line.
2. Change `prepareRename` to take a Monaco model and position instead of an `EditorView` and offset,
   and to issue its request through the transport:

```ts
export async function prepareRename(
  session: LspSession,
  path: string,
  model: { getWordAtPosition(position: { lineNumber: number; column: number }): { word: string; startColumn: number; endColumn: number } | null },
  position: { lineNumber: number; column: number },
): Promise<RenameSubject | null> {
  const word = model.getWordAtPosition(position)
  if (!word) return null
  // `textDocument/prepareRename` is optional; a server that does not implement
  // it errors, and the word under the cursor is a good enough subject.
  try {
    await session.transport.request('textDocument/prepareRename', {
      textDocument: { uri: session.documentUri(path) },
      position: { line: position.lineNumber - 1, character: position.column - 1 },
    })
  } catch {
    // fall through to the word-based subject
  }
  return {
    symbol: word.word,
    position: { line: position.lineNumber - 1, character: position.column - 1 },
  }
}
```

3. Change `buildRenamePlan` to request through the transport rather than the old client:

```ts
  const edit = await session.transport.request<WorkspaceEdit | null>('textDocument/rename', {
    textDocument: { uri: session.documentUri(path) },
    position: subject.position,
    newName,
  })
```

Keep the rest of the function — the `splitWorkspaceEdit` call, the `isPathDirty` refusal and the
"nothing to rename" guard — exactly as written.

4. Change `applyRenamePlan` to apply current-file edits through the Monaco model instead of
   `view.dispatch`. Other-file edits still go through `fetchWorktreeFile` / `writeWorktreeFile` and the
   same `queryClient.invalidateQueries` call:

```ts
  // Monaco coalesces these into one undo stop, so a rename is a single Ctrl-Z.
  model.pushEditOperations(
    null,
    plan.currentEdits.map((edit) => ({
      range: {
        startLineNumber: edit.range.start.line + 1,
        startColumn: edit.range.start.character + 1,
        endLineNumber: edit.range.end.line + 1,
        endColumn: edit.range.end.character + 1,
      },
      text: edit.newText,
    })),
    () => null,
  )
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: errors only in `CodeFileEditor.tsx` (rewritten in Task 9). Everything under `lsp/` must be clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/terminal/lsp/
git commit -m "feat(lsp): retarget cross-file rename to monaco models and the transport"
```

---

### Task 9: Rewrite `CodeFileEditor`

**Files:**
- Modify: `frontend/src/features/terminal/CodeFileEditor.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–8
- Produces: `CodeFileEditor` with its current props unchanged — `{ worktreeId, machine, path, value, ready, onChange, onOpenDefinition, isPathDirty, reveal }` — plus the re-exported types `DefinitionReveal` and `DefinitionTarget` that `ExpandedTerminal.tsx` and `FileEditor.tsx` import.

The file drops from ~700 lines to ~300: the theme, the `basicSetup` block, the extension assembly, the
heuristics and the language loader all leave.

- [ ] **Step 1: Delete the CodeMirror surface**

Remove from `CodeFileEditor.tsx`: every `@codemirror/*` and `@uiw/react-codemirror` import,
`devdeckCodeTheme`, `syntaxDiagnostics`, `explicitHistoryKeymap`, `useFileLanguage`, `revealDefinition`,
and the symbols moved to `definitionFallback.ts` in Task 7.

Keep `DefinitionReveal` / `DefinitionTarget` exported — but redefine `DefinitionReveal` in terms of the
shared reveal type:

```ts
import type { EditorReveal } from '@/features/editor/reveal'

export interface DefinitionTarget {
  symbol?: string
  range?: EditorReveal
}
export type DefinitionReveal = EditorReveal & { symbol?: string }
```

- [ ] **Step 2: Wire the LSP session to monaco in `onMount`**

```tsx
  const handleMount = useCallback(
    (instance: editor.IStandaloneCodeEditor) => {
      const disposables: Array<{ dispose(): void }> = []

      // F2 overrides monaco's built-in `editor.action.rename`. The built-in
      // applies its WorkspaceEdit only to models that are already loaded, so a
      // rename would silently skip every file that is not open — see
      // lspWorkspaceEdit.ts. DevDeck's dialog shows the full blast radius and
      // writes the other files through the machine API instead.
      disposables.push(
        instance.addAction({
          id: 'devdeck.rename',
          label: 'Rename Symbol (DevDeck)',
          keybindings: [monaco.KeyCode.F2],
          run: (ed) => {
            const position = ed.getPosition()
            if (position) void handlersRef.current.startRename(ed, position)
          },
        }),
      )

      // Ctrl/Cmd-click and F12 reach the LSP definition provider that
      // MonacoLspClient registered. When there is no session there is no
      // provider, so the regex/import heuristics are the whole feature. The
      // action is always registered and checks for a session at call time —
      // `handleMount` must not depend on `session`, or every session transition
      // would remount the editor and lose undo history.
      disposables.push(
        instance.addAction({
          id: 'devdeck.fallbackDefinition',
          label: 'Go to Definition (heuristic)',
          keybindings: [monaco.KeyCode.F12],
          run: (ed) => {
            if (handlersRef.current.hasSession) return
            const position = ed.getPosition()
            if (position) handlersRef.current.fallbackDefinition(ed, position)
          },
        }),
      )

      return () => {
        for (const disposable of disposables) disposable.dispose()
      }
    },
    [],
  )
```

`handlersRef` is the existing latest-value ref in this component; extend the object it holds to
`{ onOpenDefinition, fallbackDefinition, startRename, hasSession: session !== null }`. Its doc comment
already explains why these handlers must not be dependencies: `ExpandedTerminal`'s `openDefinition`
closes over `layout`, which zustand replaces on any tab open/close, split or focus change, and every
mounted tab re-renders when it does.

- [ ] **Step 3: Register the editor opener alongside the session**

In the existing session `useEffect`, after `setSession(acquired.session)`:

```ts
        const opener = createEditorOpener({
          pathFromUri: acquired.session.pathFromUri,
          openPath: (targetPath, targetReveal) =>
            handlersRef.current.onOpenDefinition(targetPath, { range: targetReveal }),
        })
        openerDisposable = monaco.editor.registerEditorOpener({
          openCodeEditor: (_source, resource, selectionOrPosition) =>
            opener(resource.toString(), selectionOrPosition as never),
        })
```

Dispose it in the effect's cleanup, next to `releaseFn?.()`.

- [ ] **Step 4: Render `MonacoEditor`**

```tsx
  return (
    <>
      <MonacoEditor
        path={path}
        modelKey={`${machine.id}:${worktreeId}:${path}`}
        value={value}
        ready={ready}
        reveal={reveal}
        onChange={onChange}
        onMount={handleMount}
        ariaLabel={`Edit ${path}`}
        className="h-full min-h-0 flex-1"
      />
      <RenameSymbolDialog
        open={renameSubject !== null}
        symbol={renameSubject?.symbol ?? ''}
        plan={renamePlan}
        pending={renamePending}
        currentPath={path}
        onCancel={closeRename}
        onSubmitName={submitRenameName}
        onConfirmPlan={confirmRename}
      />
    </>
  )
```

Keep the LSP status-toast effect exactly as it is — it depends only on `session`, not on CodeMirror.

- [ ] **Step 5: Typecheck and build**

Run: `cd frontend && npm run typecheck`
Expected: errors remain only in the five surfaces still on CodeMirror. `CodeFileEditor.tsx`,
`FileEditor.tsx` and `ExpandedTerminal.tsx` must be clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/terminal/
git commit -m "feat(editor): rewrite CodeFileEditor on monaco with native LSP"
```

---

### Task 10: `PlainCodeEditor` (SSH and untitled buffers)

**Files:**
- Modify: `frontend/src/features/terminal/PlainCodeEditor.tsx`

**Interfaces:**
- Consumes: `MonacoEditor`, `LineReveal` (Task 4)
- Produces: `PlainCodeEditor` with unchanged props `{ path, value, onChange, ready?, reveal? }`, and a re-export `export type { LineReveal }` so `SSHShellPane.tsx`, `SSHFileEditor.tsx`, `MarkdownFileEditor.tsx` and `ContentSearchPanel.tsx` keep compiling.

`revealLine` was exported for `MarkdownFileEditor`; it is no longer needed — `MonacoEditor` handles
reveal internally. Remove it and update the Task 11 consumer.

- [ ] **Step 1: Replace the whole file**

```tsx
import { MonacoEditor } from '@/features/editor/MonacoEditor'
import type { LineReveal } from '@/features/editor/reveal'

export type { LineReveal }

/**
 * The editor for files with no language server: SSH files and untitled buffers.
 * Identical to CodeFileEditor minus everything LSP-specific — no
 * go-to-definition, no rename, no diagnostics. Monaco still supplies syntax
 * highlighting from its monarch tokenizers and word-based suggestions from the
 * open buffer.
 */
export function PlainCodeEditor({
  path,
  value,
  onChange,
  ready = true,
  reveal,
}: {
  path: string
  value: string
  onChange: (value: string) => void
  ready?: boolean
  /** Content search's "open at line" entry point. */
  reveal?: LineReveal
}) {
  return (
    <MonacoEditor
      path={path}
      value={value}
      ready={ready}
      reveal={reveal}
      onChange={onChange}
      ariaLabel={`Edit ${path}`}
      options={{ quickSuggestions: { other: true, comments: false, strings: false } }}
      className="h-full min-h-0 flex-1"
    />
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: `PlainCodeEditor.tsx`, `SSHFileEditor.tsx`, `UntitledFileEditor.tsx` and `SSHShellPane.tsx`
clean. `MarkdownFileEditor.tsx` still errors on `revealLine` — Task 11.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/terminal/PlainCodeEditor.tsx
git commit -m "feat(editor): move PlainCodeEditor to monaco"
```

---

### Task 11: `MarkdownFileEditor`

**Files:**
- Modify: `frontend/src/features/terminal/MarkdownFileEditor.tsx`

**Interfaces:**
- Consumes: `MonacoEditor`, `LineReveal`
- Produces: `MarkdownFileEditor` with unchanged props `{ path, value, ready, onChange, reveal }`

The editor/preview split, the toolbar, `TOOLBAR_ACTIONS` and `SLASH_COMMANDS` all stay. Only the editor
half changes. The toolbar currently mutates through a CodeMirror `EditorView`; it must now mutate through
the Monaco model.

- [ ] **Step 1: Replace the CodeMirror imports and the editor half**

Delete every `@codemirror/*` / `@uiw/react-codemirror` import plus the
`import { devdeckCodeTheme, explicitHistoryKeymap, useFileLanguage } from './CodeFileEditor'` and
`import { revealLine, type LineReveal } from './PlainCodeEditor'` lines. Replace with:

```tsx
import type { editor } from 'monaco-editor/editor'
import { MonacoEditor } from '@/features/editor/MonacoEditor'
import type { LineReveal } from '@/features/editor/reveal'
```

Hold the instance in a ref so the toolbar can drive it:

```tsx
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  const handleMount = useCallback((instance: editor.IStandaloneCodeEditor) => {
    editorRef.current = instance
    return () => {
      editorRef.current = null
    }
  }, [])
```

- [ ] **Step 2: Port the toolbar's text mutation**

Replace whatever `view.dispatch({changes})` call the toolbar and slash commands use with:

```tsx
  /** Applies a toolbar action or slash command at the cursor. `executeEdits`
   *  keeps the change on monaco's undo stack and leaves the cursor where the
   *  action asked for it, which `model.setValue` would not. */
  const applyEdit = useCallback((text: string, selectInserted = false) => {
    const instance = editorRef.current
    if (!instance) return
    const selection = instance.getSelection()
    if (!selection) return
    instance.executeEdits('devdeck.markdown', [{ range: selection, text, forceMoveMarkers: true }])
    if (selectInserted) instance.setSelection(selection)
    instance.focus()
  }, [])
```

Wire `TOOLBAR_ACTIONS` and `SLASH_COMMANDS` through `applyEdit`, preserving each action's existing
wrapping behaviour (bold/italic/link etc. wrap the current selection — read the selected text with
`instance.getModel()?.getValueInRange(selection)` before replacing it).

- [ ] **Step 3: Render `MonacoEditor` in the editor pane**

```tsx
        <MonacoEditor
          path={path}
          value={value}
          ready={ready}
          reveal={reveal}
          onChange={onChange}
          onMount={handleMount}
          language="markdown"
          ariaLabel={`Edit ${path}`}
          options={{ wordWrap: 'on', lineNumbers: 'off', quickSuggestions: false }}
          className="h-full min-h-0 flex-1"
        />
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: `MarkdownFileEditor.tsx` clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/terminal/MarkdownFileEditor.tsx
git commit -m "feat(editor): move MarkdownFileEditor to monaco"
```

---

### Task 12: `DBSqlEditor` and schema-aware SQL completion

**Files:**
- Modify: `frontend/src/features/database/DBSqlEditor.tsx`
- Modify: `frontend/src/features/database/sqlEditorSupport.ts` (comment only)
- Create: `frontend/src/features/database/sqlCompletion.ts`
- Test: `frontend/src/features/database/sqlCompletion.test.ts`
- Modify: `frontend/vite.config.ts` (`test.include`)

**Interfaces:**
- Consumes: `buildSQLSchema` and `SQLSchemaMap` from `./sqlEditorSupport` (unchanged), `MonacoEditor`
- Produces: `sqlCompletionItems(schema: SQLSchemaMap, prefix: string | null): Array<{ label: string; kind: 'table' | 'column' | 'schema'; detail: string }>`

`sqlEditorSupport.ts` imports nothing from CodeMirror — only a comment mentions `SQLNamespace`. Its
204-line test suite must stay green **unchanged**; only that comment is corrected.

**`SQLSchemaMap` is a union, not a flat map.** From `sqlEditorSupport.ts:50`:

```ts
export type SQLSchemaMap = Record<string, string[] | Record<string, string[]>>
```

A top-level key is *either* a bare table (value is its column list) *or* a schema (value is a map of its
tables). `buildSQLSchema` writes bare table names first and then adds `out[schemaName] = {...}` for each
named schema, so both shapes coexist in one object. The completion source must branch on
`Array.isArray(value)`.

- [ ] **Step 1: Write the failing completion test**

Create `frontend/src/features/database/sqlCompletion.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { sqlCompletionItems } from './sqlCompletion'

import type { SQLSchemaMap } from './sqlEditorSupport'

/** Mirrors what buildSQLSchema emits for a Postgres connection: bare table
 *  names at the top level, plus a nested entry per named schema. */
const schema: SQLSchemaMap = {
  users: ['id', 'email'],
  orders: ['id', 'user_id', 'total'],
  public: { users: ['id', 'email'], orders: ['id', 'user_id', 'total'] },
}

describe('sqlCompletionItems', () => {
  it('offers bare tables and schemas when there is no prefix', () => {
    const items = sqlCompletionItems(schema, null)
    expect(items.map((i) => i.label).sort()).toEqual(['orders', 'public', 'users'])
    expect(items.find((i) => i.label === 'users')!.kind).toBe('table')
    expect(items.find((i) => i.label === 'public')!.kind).toBe('schema')
  })

  it('offers the columns of a bare table prefix', () => {
    const items = sqlCompletionItems(schema, 'users')
    expect(items.map((i) => i.label)).toEqual(['id', 'email'])
    expect(items.every((i) => i.kind === 'column')).toBe(true)
    expect(items[0].detail).toBe('users')
  })

  it('offers the tables of a schema prefix', () => {
    const items = sqlCompletionItems(schema, 'public')
    expect(items.map((i) => i.label).sort()).toEqual(['orders', 'users'])
    expect(items.every((i) => i.kind === 'table')).toBe(true)
    expect(items[0].detail).toBe('public')
  })

  it('is case-insensitive on the prefix', () => {
    expect(sqlCompletionItems(schema, 'USERS').map((i) => i.label)).toEqual(['id', 'email'])
  })

  it('returns nothing for an unknown prefix', () => {
    expect(sqlCompletionItems(schema, 'nope')).toEqual([])
  })

  it('handles an empty schema', () => {
    expect(sqlCompletionItems({}, null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/features/database/sqlCompletion.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sqlCompletion.ts`**

```ts
import type { SQLSchemaMap } from './sqlEditorSupport'

export interface SqlCompletionItem {
  label: string
  kind: 'table' | 'column' | 'schema'
  detail: string
}

/**
 * Replaces `@codemirror/lang-sql`'s schema-aware completion, which monaco has no
 * equivalent for — its bundled SQL support is a monarch tokenizer only.
 * Pure, so the prefix rules are testable without an editor; the caller adapts
 * the result to `monaco.languages.CompletionItem`.
 *
 * `SQLSchemaMap` is a union: a top-level value is either a bare table's column
 * list or a schema's map of tables, and buildSQLSchema emits both at once. Every
 * branch here keys off `Array.isArray`.
 */
export function sqlCompletionItems(
  schema: SQLSchemaMap,
  prefix: string | null,
): SqlCompletionItem[] {
  if (prefix) {
    const key = Object.keys(schema).find((name) => name.toLowerCase() === prefix.toLowerCase())
    if (key === undefined) return []
    const value = schema[key]
    // A bare table -> its columns. A schema -> the tables inside it.
    return Array.isArray(value)
      ? value.map((column) => ({ label: column, kind: 'column' as const, detail: key }))
      : Object.keys(value).map((table) => ({
          label: table,
          kind: 'table' as const,
          detail: key,
        }))
  }

  return Object.entries(schema).map(([name, value]) => ({
    label: name,
    kind: Array.isArray(value) ? ('table' as const) : ('schema' as const),
    detail: Array.isArray(value) ? 'table' : 'schema',
  }))
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/features/database/sqlCompletion.test.ts`
Expected: PASS

- [ ] **Step 5: Swap the editor in `DBSqlEditor.tsx`**

Delete the `@codemirror/*` and `@uiw/react-codemirror` imports. Register the completion provider once,
scoped to the `sql` language, and dispose it on unmount:

```tsx
  const handleMount = useCallback(
    (instance: editor.IStandaloneCodeEditor) => {
      const completion = monaco.languages.registerCompletionItemProvider('sql', {
        triggerCharacters: ['.'],
        provideCompletionItems: (model, position) => {
          const untilPosition = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          })
          const qualified = /([A-Za-z_][\w$]*)\.\s*$/.exec(untilPosition)
          const word = model.getWordUntilPosition(position)
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          }
          return {
            suggestions: sqlCompletionItems(schemaRef.current, qualified?.[1] ?? null).map(
              (item) => ({
                label: item.label,
                detail: item.detail,
                insertText: item.label,
                range,
                kind:
                  item.kind === 'column'
                    ? monaco.languages.CompletionItemKind.Field
                    : item.kind === 'schema'
                      ? monaco.languages.CompletionItemKind.Module
                      : monaco.languages.CompletionItemKind.Struct,
              }),
            ),
          }
        },
      })

      // Ctrl/Cmd-Enter runs the query — the binding the CodeMirror keymap had.
      const run = instance.addAction({
        id: 'devdeck.runQuery',
        label: 'Run Query',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        run: () => {
          runQueryRef.current()
        },
      })

      return () => {
        completion.dispose()
        run.dispose()
      }
    },
    [],
  )
```

`schemaRef` and `runQueryRef` are `useRef`s updated in an effect on every render, so the provider closes
over stable identities and is registered exactly once.

Render:

```tsx
        <MonacoEditor
          path="query.sql"
          value={sql}
          onChange={setSql}
          onMount={handleMount}
          language="sql"
          ariaLabel="SQL editor"
          className="h-full min-h-0 flex-1"
        />
```

Keep the Format button, history rows, export and all other existing behaviour — `sql-formatter` is
independent of the editor.

- [ ] **Step 6: Register the test, run everything, typecheck**

Add to `test.include`:

```ts
      'src/features/database/sqlCompletion.test.ts',
```

Run: `cd frontend && npx vitest run src/features/database/ && npm run typecheck`
Expected: `sqlEditorSupport.test.ts` and `sqlCompletion.test.ts` PASS; `DBSqlEditor.tsx` clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/database/ frontend/vite.config.ts
git commit -m "feat(database): move the SQL editor to monaco with schema-aware completion"
```

---

### Task 13: `EnvSettingsEditor` and JSON markers

**Files:**
- Modify: `frontend/src/features/agent-management/EnvSettingsEditor.tsx`
- Create: `frontend/src/features/editor/jsonMarkers.ts`
- Test: `frontend/src/features/editor/jsonMarkers.test.ts`
- Modify: `frontend/vite.config.ts` (`test.include`)

**Interfaces:**
- Consumes: `MonacoEditor`
- Produces: `jsonParseMarker(text: string): { message: string; line: number; column: number } | null`

Monaco's JSON language feature is not shipped (decision 4), so `jsonParseLinter` is replaced by a
`JSON.parse` in a try/catch whose thrown position is mapped to a marker.

- [ ] **Step 1: Write the failing marker test**

Create `frontend/src/features/editor/jsonMarkers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { jsonParseMarker } from './jsonMarkers'

describe('jsonParseMarker', () => {
  it('returns null for valid JSON', () => {
    expect(jsonParseMarker('{"a": 1}')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(jsonParseMarker('   ')).toBeNull()
  })

  it('reports the line of a syntax error', () => {
    const marker = jsonParseMarker('{\n  "a": 1,\n  "b" 2\n}')
    expect(marker).not.toBeNull()
    expect(marker!.line).toBe(3)
    expect(marker!.message).toBeTruthy()
  })

  it('reports line 1 when the error is on the first line', () => {
    const marker = jsonParseMarker('{ "a" 1 }')
    expect(marker!.line).toBe(1)
  })

  it('defaults to line 1 when the engine gives no position', () => {
    const marker = jsonParseMarker('{')
    expect(marker!.line).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/features/editor/jsonMarkers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `jsonMarkers.ts`**

```ts
/**
 * Replaces `@codemirror/lang-json`'s `jsonParseLinter`. Monaco's own JSON
 * language feature would do this — and schema validation besides — but it is
 * deliberately not shipped: pulling `languages/features/*` in also registers the
 * TypeScript feature's 12 MB payload. For a settings file, a parse check is
 * enough.
 *
 * V8, SpiderMonkey and JavaScriptCore all report a character offset in the
 * message ("at position 12"), and V8 additionally reports "(line 3 column 7)".
 * Both shapes are handled; anything unrecognised falls back to line 1 so the
 * error is still surfaced rather than swallowed.
 */
export function jsonParseMarker(text: string) {
  if (!text.trim()) return null
  try {
    JSON.parse(text)
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON'

    const lineColumn = /line (\d+) column (\d+)/.exec(message)
    if (lineColumn) {
      return { message, line: Number(lineColumn[1]), column: Number(lineColumn[2]) }
    }

    const position = /position (\d+)/.exec(message)
    if (position) {
      const offset = Math.min(Number(position[1]), text.length)
      const before = text.slice(0, offset)
      return {
        message,
        line: before.split('\n').length,
        column: offset - (before.lastIndexOf('\n') + 1) + 1,
      }
    }

    return { message, line: 1, column: 1 }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/features/editor/jsonMarkers.test.ts`
Expected: PASS

- [ ] **Step 5: Swap the editor in `EnvSettingsEditor.tsx`**

Delete every `@codemirror/*` and `@uiw/react-codemirror` import. Add a marker effect and render
`MonacoEditor`:

```tsx
  const handleMount = useCallback((instance: editor.IStandaloneCodeEditor) => {
    const model = instance.getModel()
    if (!model) return

    const revalidate = () => {
      const marker = jsonParseMarker(model.getValue())
      monaco.editor.setModelMarkers(model, 'devdeck-json', marker
        ? [{
            severity: monaco.MarkerSeverity.Error,
            message: marker.message,
            startLineNumber: marker.line,
            startColumn: marker.column,
            endLineNumber: marker.line,
            endColumn: model.getLineMaxColumn(Math.min(marker.line, model.getLineCount())),
          }]
        : [])
    }

    revalidate()
    const sub = model.onDidChangeContent(revalidate)
    return () => {
      sub.dispose()
      monaco.editor.setModelMarkers(model, 'devdeck-json', [])
    }
  }, [])
```

Render with `language="json"` and keep the existing save/undo/redo buttons — rebind undo/redo to
`instance.trigger('devdeck', 'undo', null)` and `'redo'`.

- [ ] **Step 6: Register the test, run, typecheck**

Add to `test.include`:

```ts
      'src/features/editor/jsonMarkers.test.ts',
```

Run: `cd frontend && npx vitest run src/features/editor/ && npm run typecheck`
Expected: PASS; `EnvSettingsEditor.tsx` clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/ frontend/vite.config.ts
git commit -m "feat(agents): move the env settings editor to monaco with JSON markers"
```

---

### Task 14: `SkillContentDialog`

**Files:**
- Modify: `frontend/src/features/agent-management/SkillContentDialog.tsx`

**Interfaces:**
- Consumes: `MonacoEditor`
- Produces: no API change

This is the smallest surface: it only needs syntax highlighting and a read-only toggle
(`EditorView.editable.of(false)` today).

- [ ] **Step 1: Swap the editor**

Delete the `@codemirror/*` and `@uiw/react-codemirror` imports along with the `useFileLanguage`
machinery, and render:

```tsx
        <MonacoEditor
          path={skillPath}
          value={content}
          onChange={setContent}
          readOnly={!editing}
          ariaLabel={`Skill ${skillPath}`}
          className="h-full min-h-0 flex-1"
        />
```

`readOnly` replaces the `EditorView.editable` extension; `MonacoEditor` already forwards it into
`updateOptions`, so toggling edit mode does not remount or lose scroll position.

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: `SkillContentDialog.tsx` clean. No `@codemirror` import should remain anywhere in `src/`.

Run: `rg -l "@codemirror|@uiw/react-codemirror|codemirror-languageserver" frontend/src` — expected: only
`lspExtensions.ts` and `lspExtensions.test.ts`, both deleted in Task 16.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/agent-management/SkillContentDialog.tsx
git commit -m "feat(agents): move the skill content dialog to monaco"
```

---

### Task 15: The VS Code mode setting

**Files:**
- Modify: `frontend/src/features/overlays/DesktopSettingsDialog.tsx`

**Interfaces:**
- Consumes: `useVsCodeMode` (Task 2)
- Produces: no API change

- [ ] **Step 1: Add an Editor section**

Read `DesktopSettingsDialog.tsx` first and follow the existing two-pane section pattern exactly — the
same heading, description and switch components other sections use. Add:

```tsx
  const [vscodeMode, setVsCodeModeEnabled] = useVsCodeMode()
```

and a row whose label is `VS Code mode`, whose description reads:

> Full IDE chrome — minimap, breadcrumbs, sticky scroll, folding and bracket guides. When off, the editor stays minimal: line numbers and syntax only.

wired to `checked={vscodeMode}` / `onCheckedChange={setVsCodeModeEnabled}`.

- [ ] **Step 2: Verify it applies live**

Run: `cd frontend && npm run dev`, open a code file, toggle the setting, and confirm the minimap and
breadcrumbs appear and disappear **without** the editor remounting — type a character first and confirm
Ctrl-Z still undoes it after toggling.

- [ ] **Step 3: Typecheck and commit**

```bash
cd frontend && npm run typecheck
git add frontend/src/features/overlays/DesktopSettingsDialog.tsx
git commit -m "feat(settings): add the global VS Code mode toggle"
```

---

### Task 16: Delete CodeMirror

**Files:**
- Delete: `frontend/src/features/terminal/lspExtensions.ts`, `frontend/src/features/terminal/lspExtensions.test.ts`
- Modify: `frontend/package.json`, `frontend/vite.config.ts`

- [ ] **Step 1: Delete the dead modules**

```bash
cd frontend
git rm src/features/terminal/lspExtensions.ts src/features/terminal/lspExtensions.test.ts
```

Remove `'src/features/terminal/lspExtensions.test.ts'` from `test.include` in `vite.config.ts`.

- [ ] **Step 2: Confirm nothing references CodeMirror**

Run: `rg -i "codemirror|@uiw|@lezer" frontend/src`
Expected: **no matches**. Any hit is a missed migration — fix it before continuing.

- [ ] **Step 3: Remove the packages**

```bash
cd frontend
npm uninstall @codemirror/autocomplete @codemirror/commands @codemirror/lang-sql \
  @codemirror/language @codemirror/language-data @codemirror/lint @codemirror/state \
  @codemirror/theme-one-dark @codemirror/view @uiw/react-codemirror codemirror-languageserver
```

`vscode-languageserver-protocol` **stays** — the transport and rename flow use its types.

- [ ] **Step 4: Verify the tree is clean**

```bash
cd frontend
rg -i "codemirror|@uiw/react-codemirror" package.json   # expected: no matches
npm run typecheck
npm test
npm run build
```

Expected: all PASS.

- [ ] **Step 5: Report the bundle delta**

```bash
cd frontend
echo "chunks: $(ls dist/assets/*.js | wc -l)"
du -ch dist/assets/*.js | tail -1
```

Compare against the pre-migration baseline recorded in the spec — **5.4 MB across 241 chunks**. State the
delta in the commit body. If total JS grew by more than ~1.5 MB, check that
`dist/assets/` contains no chunk named after `tsMode` or `typescriptServices`; if it does, something
imported `monaco-editor` root or `languages/features/*`, violating a global constraint.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/
git commit -m "chore(editor): delete CodeMirror and remove its packages"
```

---

### Task 17: Full verification

**Files:** none — this task only runs gates.

- [ ] **Step 1: Frontend gates**

```bash
cd frontend
npm run typecheck && npm test && npm run build
```

Expected: all PASS.

- [ ] **Step 2: Backend gate**

```bash
cd backend && go vet ./... && go test ./...
```

Expected: PASS. The backend was not modified; this confirms it.

- [ ] **Step 3: Manual smoke test**

Run `npm run dev` and verify each surface, since none of these are covered by unit tests:

1. Open a `.go` file in a worktree — syntax highlighting, completions from gopls, hover, diagnostics.
2. Ctrl/Cmd-click a symbol defined in another file — a new tab opens at the definition.
3. F2 on a symbol used in several files — the rename dialog lists every file, and confirming rewrites them.
4. Open a file over SSH — highlighting, no LSP, no errors in the console.
5. Open a markdown file — editor and preview, toolbar actions still insert correctly.
6. Run a SQL query — `.` after a table name completes its columns; Ctrl/Cmd-Enter runs.
7. Open agent env settings — malformed JSON shows a red squiggle.
8. Open a skill — read-only until Edit is pressed.
9. Toggle VS Code mode in Settings → Editor — minimap and breadcrumbs appear on every open editor.
10. Drag an editor tab to split the pane — the editor keeps its content, undo history and LSP features.
11. Open DevTools → Network, open a `.ts` file, and confirm **no** chunk over ~2 MB is fetched. This is the check that the TypeScript feature stayed out.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix(editor): address smoke-test findings"
```
