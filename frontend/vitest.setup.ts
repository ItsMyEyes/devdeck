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
