# CLAUDE.md

Local web UI (Vite/React + Express/node-pty) that runs a real Claude Code CLI
session in a browser terminal. Detail lives in dedicated files, read on demand:

- **Architecture / data flow / key files** → `ARCHITECTURE.md`
- **Protocol & code contracts** (WS message shape, PTY guards) → `CONTRACTS.md`
- **Run / build / test commands** → `COMMANDS.md`

## Non-Negotiables

- On Windows, `node-pty` needs the exact CLI filename with extension — never
  hardcode `'claude'`; use the PATH-search resolver. (See `ARCHITECTURE.md`.)
- Only one active session at a time (v1 scope). Don't remove the
  `registry.size() > 0` guard without also reworking the client's
  single-session assumptions.
- Server binds `127.0.0.1` only, no auth. Never widen the bind address
  without adding auth first — this is a local-only tool by design.
- `ClientMessage`/`ServerControlMessage` (`client/src/lib/protocol.ts`) and the
  server's message switch (`server/src/createApp.ts`) are a closed union kept
  in sync by hand — adding a message type means updating both.
- Guard every WebSocket `.send()` with a `readyState === OPEN` check (both
  sides) — sends against a closing/closed socket throw.
- No automated frontend test suite for v1 — terminal behavior is verified
  manually, don't add one speculatively. (See `CONTRACTS.md` for what server
  tests do cover.)
