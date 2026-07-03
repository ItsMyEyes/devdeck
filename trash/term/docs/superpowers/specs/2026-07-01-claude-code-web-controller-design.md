# Claude Code Web Controller — Design

Date: 2026-07-01

## Summary

A local web app that lets a browser control a real Claude Code CLI session:
a Node.js backend spawns `claude` inside a pseudo-terminal (PTY) and tunnels
it over a WebSocket to a Vite + React + shadcn/ui frontend rendering an
`xterm.js` terminal. Full terminal fidelity (colors, interactive prompts,
permission dialogs, plan-mode UI) is preserved because the CLI runs in a real
TTY, not a plain pipe.

## Scope

- Single active Claude Code session at a time.
- Working directory is chosen per-session via a form in the browser (not
  fixed in config).
- No authentication — server binds to localhost only; this is a personal
  local dev tool, not something exposed to a network.
- A dropped WebSocket does not kill the session: the PTY keeps running
  server-side and the browser can reattach to it (see Session Resume).
- Out of scope for v1: multiple concurrent sessions/tabs, remote/network
  access, auth, automated frontend tests.

## Architecture

Two packages in one repo:

- **`server/`** — Express + `ws` + `node-pty`. Holds a registry of sessions
  keyed by `sessionId`. Spawns `claude` in a PTY at the client-provided
  working directory, streams PTY output over the WebSocket, forwards
  keystrokes/resizes back into the PTY.
- **`client/`** — Vite + React + shadcn/ui (Tailwind-based) + `xterm.js`
  (+ `xterm-addon-fit`). A session form (working directory input) that,
  once started, is replaced by a full-size terminal wired to the backend
  over WebSocket.

Both processes run on `localhost` only (dev: separate ports with Vite proxy
or CORS; simplest option decided at implementation time).

## Components

### Server (`server/src/`)

- `index.ts` — Express app + HTTP server + `WebSocketServer` attached to it.
  Wires incoming WS connections to the session registry.
- `sessionRegistry.ts` — `Map<sessionId, Session>` where
  `Session = { pty, outputBuffer: RingBuffer, killTimer: NodeJS.Timeout | null }`.
  - `createSession(cwd)`: validates cwd exists, spawns `claude` via
    `node-pty`, generates a `sessionId` (uuid), registers it, returns it.
  - `attachSession(sessionId, socket)`: looks up the session, cancels its
    kill timer if pending, replays `outputBuffer` to the socket, then wires
    live PTY output to the socket going forward.
  - `detachSession(sessionId)`: called on socket close; starts a grace timer
    (default 5 minutes) that kills the PTY and removes the session if no one
    reattaches in time.
  - `outputBuffer`: a rolling buffer capped at ~64KB of the most recent raw
    PTY output, appended to on every PTY data event, used only for replay on
    reattach.

- **WS message protocol** (JSON control frames, plus raw un-wrapped PTY
  output frames so xterm.js can consume them directly):
  - Client → Server:
    - `{type: "start", cwd: string}` — create a new session
    - `{type: "attach", sessionId: string}` — reattach to an existing session
    - `{type: "input", data: string}` — keystrokes
    - `{type: "resize", cols: number, rows: number}`
  - Server → Client:
    - `{type: "started", sessionId: string}`
    - `{type: "not_found"}` — reattach failed, session is gone
    - `{type: "error", message: string}` — bad cwd, spawn failure, etc.
    - `{type: "exit", code: number}` — process exited
    - raw PTY output chunks (plain text/binary frames)

### Client (`client/src/`)

- `App.tsx` — session state machine: `idle | connecting | running | exited`.
  Renders `SessionForm` or `Terminal` accordingly. On mount, checks
  `localStorage` for a saved `sessionId` and attempts `attach` before
  falling back to `idle`.
- `SessionForm.tsx` — shadcn `Input` + `Button`; working directory field
  (defaults to last-used value from `localStorage`); calls `onStart(cwd)`.
- `Terminal.tsx` — mounts `xterm.js` + fit addon, opens the WebSocket, pipes
  PTY output into the terminal, pipes terminal keystrokes into `input`
  messages, sends `resize` on container resize.
- `useWebSocket.ts` — hook wrapping connect / send / close and exposing
  connection state; does not itself retry — reconnect is a user-visible
  state (see Error Handling) not a silent background loop, since silently
  retrying against a possibly-gone session would be confusing.

## Data Flow

1. Browser keystroke → xterm `onData` → WS `input` message → server
   `pty.write()` → `claude` reacts → PTY emits output → server forwards raw
   bytes over WS (and appends to the session's ring buffer) → xterm
   `write()` renders it.
2. New session: form submit → WS `start` message → server validates cwd →
   spawns PTY → registers session → replies `started` with `sessionId` →
   client stores `sessionId` in `localStorage` and switches to `Terminal`.
3. Resume: on reconnect, client sends `attach` with the stored `sessionId` →
   server cancels kill timer, replays buffered output, resumes live stream.

## Error Handling

- Nonexistent working directory: server checks before spawn, replies
  `error` instead of spawning; client shows it inline on the form.
- `claude` binary not found / spawn failure: caught and reported via
  `error`, same as above — no silent hang.
- Process exit (quit, crash, Ctrl+D): server sends `exit`; client shows an
  "Session ended" state with a button back to the form; the session is
  removed from the registry immediately (nothing to resume).
- WebSocket drops unexpectedly: PTY is **not** killed immediately — the
  session enters a grace period (default 5 minutes) via `detachSession`'s
  kill timer. Client shows a "Disconnected — reconnecting" state and
  attempts `attach` with the stored `sessionId`.
- Reattach to a session that no longer exists (grace period expired or
  server restarted): server replies `not_found`; client clears the stored
  `sessionId` and falls back to the start form.
- Server-side: PTY/session errors are caught per-session and turned into an
  `error`/`exit` message rather than crashing the whole Node process.

## Testing

- Primarily manual/integration: start the server, open the client, start a
  session in a real directory, drive an actual Claude Code session
  end-to-end through the browser terminal, including a permission prompt.
  Also manually verify: closing the browser tab and reopening it within the
  grace period resumes the same session with recent output intact.
- Lightweight automated server-side tests:
  - `createSession` rejects a nonexistent cwd.
  - A real PTY spawned via `createSession` is actually killed by the grace
    timer (or by explicit exit) — no leaked processes.
  - `attachSession` replays buffered output and cancels a pending kill
    timer.
- No automated frontend test suite for v1 — terminal rendering behavior is
  verified by hand.
