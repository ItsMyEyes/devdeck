import '@testing-library/jest-dom/vitest'

// jsdom ships no ResizeObserver, and `useNativeOverlayBlocker` constructs one
// for every rect-scoped blocker. Without this stub any test that opens a
// Select/Combobox/Tooltip throws out of a passive effect.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

// jsdom has no `document.queryCommandSupported`. Monaco's clipboard contrib
// calls it as a *module-load* side effect (not inside a mounted editor), so
// merely importing monaco-editor's registered features — which the alias
// guard test in features/editor does, to confirm MonacoLspClient resolves —
// throws without this stub.
if (typeof document.queryCommandSupported !== 'function') {
  document.queryCommandSupported = () => false
}
