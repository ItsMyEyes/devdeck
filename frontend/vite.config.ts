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
      'src/features/terminal/lspTransport.test.ts',
      'src/features/terminal/lspSession.test.ts',
      'src/features/terminal/lspWorkspaceEdit.test.ts',
    ],
    // The route tree is generated at build time; excluding it keeps a cold
    // `npm test` from depending on `pretypecheck` having been run.
    exclude: ['node_modules/**', 'dist/**', 'src-tauri/**'],
  },
})
