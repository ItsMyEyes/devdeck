# Architecture

> Referenced from CLAUDE.md. Read when working on session lifecycle, WS wiring,
> or the terminal UI.

## Stack

- `server/`: Express + `ws` + `node-pty`, TypeScript (ESM), tested with Vitest.
- `client/`: Vite + React 19 + shadcn/ui (Tailwind v4) + `xterm.js` +
  `xterm-addon-fit`, linted with `oxlint`.
- No database — session state lives in an in-memory `Map` in the server
  process; nothing persists across a server restart.

## Data flow

1. Browser keystroke → xterm `onData` → WS `input` message → server
   `pty.write()` → `claude` reacts → PTY emits output → server forwards raw
   bytes over WS (and appends to the session's ring buffer) → xterm `write()`.
2. New session: form submit → WS `start {cwd}` → server validates cwd exists
   → spawns PTY via `node-pty` → registers session → replies
   `started {sessionId}` → client stores `sessionId` in `localStorage`.
3. Resume: on reconnect, client sends `attach {sessionId}` → server cancels
   the pending kill timer, replays the ring-buffered output, resumes the live
   stream.
4. Disconnect: WS `close` → `detach(sessionId)` starts a grace timer
   (`SESSION_GRACE_MS`, default 5 min) — the PTY is **not** killed
   immediately, only when the timer fires with no reattach.

## Windows CLI resolution

`node-pty` requires the exact executable filename (extension included) on
Windows — it does not do shell-style PATHEXT resolution. `server/src/index.ts`
(`resolveClaudeCommand`) searches `PATH` for `claude.exe`, then `claude.cmd`,
then bare `claude`, and falls back to `claude.exe`. `CLAUDE_COMMAND` env var
overrides this entirely. On non-Windows platforms it's always `'claude'`.

## Key files

| Path | Purpose |
|---|---|
| `server/src/index.ts` | Entry point; CLI resolution, env config, `server.listen` |
| `server/src/createApp.ts` | Express app + `WebSocketServer`; the WS message switch |
| `server/src/sessionRegistry.ts` | Session map, PTY spawn/attach/detach/write/resize |
| `server/src/ringBuffer.ts` | Rolling byte-capped output buffer for reattach replay |
| `client/src/App.tsx` | Session state machine: idle → starting → attaching → running → exited |
| `client/src/hooks/useWebSocket.ts` | WS connect/send/close; exposes connection status |
| `client/src/components/Terminal.tsx` | Mounts xterm.js, wires PTY output ↔ terminal ↔ WS |
| `client/src/components/SessionForm.tsx` | Working-directory input, last value from `localStorage` |
| `client/src/lib/protocol.ts` | `ClientMessage` / `ServerControlMessage` union types |
