import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Go backend port (handles both REST /api and WebSocket /ws/terminal).
const API_PORT = process.env.LOOM_API_PORT ?? '8989'

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
    proxy: {
      // xterm.js <-> Go PTY terminal gateway
      '/ws/terminal': {
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
})
