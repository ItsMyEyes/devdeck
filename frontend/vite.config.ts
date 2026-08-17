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
  build: {
    // Vite's default is 500 kB, which this app can never meet and should not
    // try to: every chunk above it is a *lazily loaded* vendor bundle whose
    // size is the library's, not ours. Nothing here is on the initial load —
    // the entry chunk is ~335 kB and the app is already split per route.
    //
    // What sets the floor, largest first (`vite build` prints the rest):
    //   editor.api    2,656 kB  monaco-editor's core; one import graph, and
    //                           the single biggest chunk the warning counts.
    //   monacoSetup   1,196 kB  monaco's language/feature contributions.
    //   ExpandedTerminal 850 kB  xterm + its addons (~530 kB) alongside the
    //                           terminal and agent-chat panes. The one chunk
    //                           here that is ours and *could* be split
    //                           further, by making the non-default panes
    //                           `lazy()` — see the note in COMMANDS.md.
    //   emacs-lisp/cpp/wasm      Shiki TextMate grammars, already one
    //                 620-780 kB dynamic chunk per language: exactly the
    //                           code-splitting the warning asks for, and a
    //                           single grammar is simply this big.
    //   chunk-KEIR6QF5  663 kB  mermaid's own lazy diagram bundle.
    //
    // Monaco's web workers (ts.worker alone is 6.9 MB) dwarf all of these but
    // are built as separate worker bundles and are NOT counted by this
    // warning — verified by bracketing the limit against a real build.
    //
    // 2,800 rather than a round 5,000: it clears `editor.api` with only
    // ~140 kB of headroom, so the warning still fires the moment anything
    // grows meaningfully rather than becoming permanent background noise.
    chunkSizeWarningLimit: 2800,
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
      'src/styles/globals.tokens.test.ts',
      'src/features/useReducedTransparency.test.ts',
      'src/features/palette/**/*.test.{ts,tsx}',
      'src/features/rich-editor/**/*.test.{ts,tsx}',
      'src/features/ssh/{sshCommand,sshQuickAdd,jumpHostDraft}.test.ts',
      'src/features/tabs/tileTree.ssh.test.ts',
      'src/features/tabs/WorkspaceTileCanvas.focus.test.tsx',
      'src/lib/fuzzyHighlight.test.ts',
      'src/lib/machineWsUrl.test.ts',
      'src/features/browser/splitUrlForDisplay.test.ts',
      'src/features/browser/BrowserTabStrip.test.tsx',
      'src/components/ui/progress-line.test.tsx',
      'src/components/ui/dialog.test.tsx',
      'src/components/ui/confirm-dialog.test.tsx',
      'src/components/ui/tab-strip-popover-menu.test.tsx',
      'src/components/ai-elements/vendored.smoke.test.tsx',
      'src/features/terminal/lsp/lspTransport.test.ts',
      'src/features/terminal/lsp/lspTransport.initialize.test.ts',
      'src/features/terminal/lsp/lspTransport.request.test.ts',
      'src/features/terminal/lsp/lspTransport.languageFilter.test.ts',
      'src/features/terminal/lsp/lspTransport.uriCase.test.ts',
      'src/features/terminal/lsp/lspTransport.scheme.test.ts',
      'src/features/terminal/lsp/lspTransport.closed.test.ts',
      'src/features/terminal/lsp/lspSession.test.ts',
      'src/features/terminal/lsp/lspWorkspaceEdit.test.ts',
      'src/features/browser/useNativeOverlayBlocker.test.tsx',
      'src/features/browser/BrowserTile.activeTab.test.tsx',
      'src/features/browser/BrowserTile.loadTimeout.test.tsx',
      'src/features/browser/BrowserTile.scroll.test.tsx',
      'src/features/browser/browserLoadError.test.ts',
      'src/features/modules/BrowserModule.loadError.test.tsx',
      'src/features/browser/BrowserOmnibox.test.tsx',
      'src/features/browser/browserTilesBridge.test.ts',
      'src/features/browser/visibleTileRect.test.ts',
      'src/features/browser/browserHistory.test.ts',
      'src/features/editor/monacoLspClient.guard.test.ts',
      'src/features/editor/semanticTokens.guard.test.ts',
      'src/features/editor/jsonLanguage.guard.test.ts',
      'src/features/editor/editorTheme.guard.test.ts',
      'src/features/editor/rangeSemanticTokens.test.ts',
      'src/lib/oneDarkProDarker.test.ts',
      'src/features/theme/**/*.test.{ts,tsx}',
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
      'src/features/editor/inlineCompletions.test.ts',
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
      'src/features/terminal/Terminal.test.tsx',
      'src/features/terminal/terminalTheme.test.ts',
      'src/features/terminal/paneTree.stats.test.ts',
      'src/features/ssh/SSHShellPane.test.tsx',
      'src/features/overlays/SocksPublishSection.test.tsx',
      'src/features/overlays/ToastHost.test.tsx',
      'src/store/shellSidebars.test.ts',
      'src/features/stats/useRollingSamples.test.ts',
      'src/features/stats/StatsPane.test.tsx',
      'src/features/stats/StatsPane.tokens.test.ts',
      'src/features/ssh/SSHForwardsPanel.test.tsx',
      'src/features/ssh/SSHRightSidebar.test.tsx',
      'src/features/agent-chat/ComposerChip.test.tsx',
      'src/features/agent-chat/ComposerAttachments.test.tsx',
      'src/features/agent-chat/composerSerialize.test.ts',
      'src/features/agent-chat/terminalContext.test.ts',
      'src/features/agent-chat/composerNodes.test.ts',
      'src/features/agent-chat/composerMention.test.ts',
      'src/features/agent-chat/composerMention.ssh.test.ts',
      'src/features/agent-chat/ComposerSuggestionMenu.test.tsx',
      'src/features/agent-chat/composerSkillTrigger.test.ts',
      'src/features/agent-chat/composerSlashTrigger.test.ts',
      'src/features/agent-chat/composerBanners.test.ts',
      'src/features/agent-chat/ComposerBannerStack.test.tsx',
      'src/features/agent-chat/ComposerPromptEditor.test.tsx',
      'src/features/agent-chat/ComposerPendingUserInputPanel.test.tsx',
      'src/features/agent-chat/ComposerPendingApprovalPanel.test.tsx',
      'src/features/agent-chat/ComposerPendingApprovalActions.test.tsx',
      'src/features/agent-chat/eventReducer.test.ts',
      'src/features/agent-chat/plan.test.ts',
      'src/features/agent-chat/pendingUserInput.test.ts',
      'src/features/agent-chat/timeline.test.ts',
      'src/features/agent-chat/adapter.test.ts',
      'src/features/agent-chat/MessagesTimeline.test.tsx',
      'src/features/terminal/paneTree.agentChat.test.ts',
      'src/features/agent-chat/AgentChatPane.test.tsx',
      'src/features/agent-chat/ChatComposer.test.tsx',
      'src/features/agent-chat/ComposerControls.test.tsx',
      'src/features/agent-chat/useAgentChatSocket.test.ts',
      'src/features/agent-chat/agentChatTarget.test.ts',
      'src/features/agent-chat/SessionsPanel.test.tsx',
      'src/features/agent-chat/ModelPicker.test.tsx',
      'src/features/machines/TerminalSessionsDialog.test.tsx',
      'src/features/agent-chat/enabled.test.ts',
      'src/features/agent-chat/composerDrafts.test.ts',
      'src/features/agent-chat/promptStash.test.ts',
      'src/features/agent-chat/ComposerStashBadge.test.tsx',
      'src/features/agent-chat/ComposerStashMenu.test.tsx',
      'src/features/agent-chat/planMarkdown.test.ts',
      'src/features/agent-chat/ProposedPlanCard.test.tsx',
      'src/features/agent-chat/ComposerPlanFollowUpBanner.test.tsx',
      'src/features/data/queries.deleteAgentThread.test.ts',
    ],
    // The route tree is generated at build time; excluding it keeps a cold
    // `npm test` from depending on `pretypecheck` having been run.
    exclude: ['node_modules/**', 'dist/**', 'src-tauri/**'],
  },
})
