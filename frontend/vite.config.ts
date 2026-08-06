/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Go backend port (handles both REST /api and WebSocket /ws/terminal).
const API_PORT = process.env.DEVDECK_API_PORT ?? '8989'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Router plugin must come before the React plugin.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // monaco exports MonacoLspClient only from its root entry, which also
      // eagerly registers the 12 MB TypeScript language feature. Reach the
      // client by path instead — see monacoLspClient.guard.test.ts, which
      // pins this path against a monaco upgrade moving it.
      'monaco-lsp-client': fileURLToPath(
        new URL(
          './node_modules/monaco-editor/esm/external/monaco-lsp-client/out/index.js',
          import.meta.url,
        ),
      ),
    },
  },
  server: {
    port: 5173,
    // Lets `tailscale serve` (see `make dev`) front this dev server: Vite
    // rejects requests whose Host header it doesn't recognize, and a
    // tailnet-proxied request arrives as `<device>.<tailnet>.ts.net` rather
    // than `localhost`.
    allowedHosts: ['.ts.net'],
    proxy: {
      // xterm.js <-> Go PTY terminal gateway
      '/ws/terminal': {
        target: `ws://localhost:${API_PORT}`,
        ws: true,
        rewriteWsOrigin: true,
      },
      // xterm.js <-> Go SSH shell gateway
      '/ws/ssh': {
        target: `ws://localhost:${API_PORT}`,
        ws: true,
        rewriteWsOrigin: true,
      },
      // Go + SQLite REST backend
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Only files that have actually been migrated to Vitest. This repo still
    // has 20 hand-rolled `check()`-harness test files across the database,
    // machines, terminal and lib features that predate any runner and have no
    // `it()` blocks — a blanket `src/**/*.test.{ts,tsx}` makes `npm test` fail
    // on all of them. They are tracked as explicit debt in COMMANDS.md; add
    // each one here as it gets migrated.
    include: [
      'src/features/palette/**/*.test.{ts,tsx}',
      'src/features/ssh/{sshCommand,sshQuickAdd,jumpHostDraft}.test.ts',
      'src/features/tabs/tileTree.ssh.test.ts',
      'src/lib/fuzzyHighlight.test.ts',
      'src/features/browser/splitUrlForDisplay.test.ts',
      'src/features/browser/BrowserTabStrip.test.tsx',
      'src/components/ui/progress-line.test.tsx',
      'src/components/ui/dialog.test.tsx',
      'src/features/terminal/lsp/lspTransport.test.ts',
      'src/features/terminal/lsp/lspTransport.initialize.test.ts',
      'src/features/terminal/lsp/lspTransport.request.test.ts',
      'src/features/terminal/lsp/lspTransport.languageFilter.test.ts',
      'src/features/terminal/lsp/lspTransport.uriCase.test.ts',
      'src/features/terminal/lsp/lspTransport.closed.test.ts',
      'src/features/terminal/lsp/lspSession.test.ts',
      'src/features/terminal/lsp/lspWorkspaceEdit.test.ts',
      'src/features/browser/useNativeOverlayBlocker.test.tsx',
      'src/features/browser/BrowserTile.activeTab.test.tsx',
      'src/features/browser/BrowserTile.loadTimeout.test.tsx',
      'src/features/browser/browserLoadError.test.ts',
      'src/features/modules/BrowserModule.loadError.test.tsx',
      'src/features/browser/BrowserOmnibox.test.tsx',
      'src/features/browser/browserTilesBridge.test.ts',
      'src/features/browser/visibleTileRect.test.ts',
      'src/features/browser/browserHistory.test.ts',
      'src/features/editor/monacoLspClient.guard.test.ts',
      'src/features/editor/editorOptions.test.ts',
      'src/features/editor/useVsCodeMode.test.ts',
      'src/features/editor/languageForPath.test.ts',
      'src/features/documents/documentKind.test.ts',
      'src/features/documents/zip.test.ts',
      'src/features/documents/ooxml.test.ts',
      'src/features/documents/docx.test.ts',
      'src/features/documents/sheet.test.ts',
      'src/features/documents/slides.test.ts',
      'src/features/editor/modelRegistry.test.ts',
      'src/features/editor/reveal.test.ts',
      'src/features/editor/MonacoEditor.reveal.test.tsx',
      'src/features/terminal/lsp/lspDefinition.test.ts',
      'src/features/terminal/lsp/lspReferences.test.ts',
      'src/features/terminal/lsp/definitionFallback.test.ts',
      'src/features/terminal/lsp/editorOpener.test.ts',
      'src/features/database/sqlCompletion.test.ts',
      'src/features/editor/jsonMarkers.test.ts',
      'src/features/terminal/shellTransfer.test.ts',
      'src/features/terminal/dropTarget.test.ts',
      'src/features/terminal/explorerClipboard.test.ts',
      'src/features/terminal/useDragAutoExpand.test.tsx',
      'src/features/terminal/dragImage.test.ts',
      'src/features/terminal/fileLocation.test.ts',
      'src/features/terminal/FileQuickOpen.test.tsx',
      'src/features/terminal/ShellSidebar.test.tsx',
      'src/features/terminal/GitPanel.test.tsx',
      'src/features/terminal/PanelHeader.test.tsx',
      'src/features/terminal/ExpandedTerminal.test.tsx',
      'src/features/ssh/SSHShellPane.test.tsx',
      'src/features/overlays/SocksPublishSection.test.tsx',
      'src/store/shellSidebars.test.ts',
      'src/features/stats/useRollingSamples.test.ts',
    ],
    // The route tree is generated at build time; excluding it keeps a cold
    // `npm test` from depending on `pretypecheck` having been run.
    exclude: ['node_modules/**', 'dist/**', 'src-tauri/**'],
  },
})
