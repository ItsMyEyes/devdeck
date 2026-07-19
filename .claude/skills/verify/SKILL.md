---
name: verify
description: Launch isolated DevDeck hub/runtime instances and drive browser features with Playwright.
---

# Verify DevDeck at the runtime surface

1. Build the current frontend with `npm --prefix frontend run build` only when embedded-UI verification is required. For active frontend work, prefer Vite so the browser cannot receive stale `backend/internal/webui/dist` assets:

   ```bash
   DEVDECK_API_PORT=<hub-port> npm --prefix frontend run dev:web -- --host 127.0.0.1 --port <vite-port>
   ```

2. Create a temporary HOME and put executable fake agent shims (`claude`, `codex`, etc.) on its PATH when the flow needs installed-agent state. Put fixture skills under that HOME's normal agent skill roots.

3. Launch isolated servers with temporary databases:

   ```bash
   HOME=<hub-home> PATH=<hub-home>/bin:$PATH go -C backend run ./cmd/server \
     --role hub --key <hub-key> --addr 127.0.0.1:<hub-port> --db <tmp>/hub.db --open=false --2fa=false

   HOME=<runtime-home> PATH=<runtime-home>/bin:$PATH go -C backend run ./cmd/server \
     --role runtime --key <runtime-key> --addr 127.0.0.1:<runtime-port> --db <tmp>/runtime.db --open=false \
     --hub-url http://127.0.0.1:<hub-port> --hub-key <hub-key> \
     --public-url http://127.0.0.1:<runtime-port> --name <runtime-name>
   ```

4. Register the hub itself as a machine through `POST /api/machines` if the UI needs multiple machine choices. The machine list is newest-first.

5. Drive `http://127.0.0.1:<vite-port>/?key=<hub-key>` with native Python Playwright and capture screenshots. The collapsed sidebar intentionally requires two clicks on a navigation icon: the first arms it, the second navigates.

6. Exercise the real UI flow plus at least one adjacent error path. Capture browser console messages and relevant network response statuses. Stop all background servers when finished.
