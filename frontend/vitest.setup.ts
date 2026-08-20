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

// jsdom implements no `Element.scrollIntoView` at all (not even a no-op) —
// https://github.com/jsdom/jsdom/issues/1695. Several suggestion-style
// popups (`ComposerSuggestionMenu.tsx`, `composerMention.ts`'s original
// `MentionMenu`, `SlashMenu.tsx`) call it unconditionally from a
// `useEffect(() => { listRef.current?.children[highlighted]?.scrollIntoView(...) }, [highlighted])`
// to keep the highlighted row visible. That effect always runs once on
// mount, so any test that renders such a menu with a non-empty item list
// from its very first render — not just ones that exercise arrow-key
// navigation — hits `TypeError: ...scrollIntoView is not a function`. A
// no-op is the honest stand-in: jsdom has no layout, so there is nothing
// real to scroll.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}

// jsdom has no `document.elementFromPoint`. ProseMirror's `posAtCoords` calls
// it on every mousedown to map a click to a document position, so any test
// that clicks inside the composer's editor throws out of the event handler —
// asynchronously, after the test that triggered it has already returned. That
// surfaces as vitest's "Unhandled Errors ... This might cause false positive
// tests", which is exactly what it sounds like: the throw escapes the test
// that caused it and lands on whichever one is running next.
//
// `null` is the honest answer in a headless DOM — nothing has layout, so no
// element is at any point. ProseMirror already treats null as "cannot
// measure" and falls back, the same contract the Range shim below relies on.
if (typeof document.elementFromPoint !== 'function') {
  document.elementFromPoint = () => null
}

// jsdom has no `document.queryCommandSupported`. Monaco's clipboard contrib
// calls it as a *module-load* side effect (not inside a mounted editor), so
// merely importing monaco-editor's registered features — which the alias
// guard test in features/editor does, to confirm MonacoLspClient resolves —
// throws without this stub.
if (typeof document.queryCommandSupported !== 'function') {
  document.queryCommandSupported = () => false
}

// jsdom implements neither `Range.getClientRects` nor
// `Range.getBoundingClientRect` (measured — `Element.getClientRects` IS there,
// which is why only Range needs this). ProseMirror measures the caret through
// a Range on every state update: `updateStateInner` → `scrollToSelection` →
// `coordsAtPos` → `singleRect`, which calls `getClientRects()` on it. Without
// these, the composer's TipTap editor throws `target.getClientRects is not a
// function` from an async ProseMirror update — i.e. AFTER the test that
// triggered it has returned, so it surfaces as an uncaught exception that
// crashes the run rather than as one failing test.
//
// Zero rects is the honest answer in a headless DOM: nothing has layout. That
// is enough for ProseMirror, which treats an empty list as "cannot measure"
// and skips the scroll. Any test asserting real geometry needs a real browser,
// not a richer lie here.
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects() {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList
  }
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return new DOMRect(0, 0, 0, 0)
  }
}

// jsdom has no `window.matchMedia`. `monaco.editor.createModel` lazily boots
// monaco's StandaloneThemeService, which queries `(forced-colors: active)` to
// track OS high-contrast mode — an *async* service-init step (`setTimeout`),
// so it throws after the calling test has already returned and crashes the
// whole run as an unhandled rejection rather than failing the one test.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}
