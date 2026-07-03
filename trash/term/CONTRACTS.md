# Contracts

> Referenced from CLAUDE.md. Mandatory patterns for this project.

## WS message protocol

JSON control frames plus raw un-wrapped PTY output frames (so xterm.js can
consume them directly without unwrapping).

Client → Server (`client/src/lib/protocol.ts: ClientMessage`):
- `{type: "start", cwd: string}`
- `{type: "attach", sessionId: string}`
- `{type: "input", data: string}`
- `{type: "resize", cols: number, rows: number}`

Server → Client (`client/src/lib/protocol.ts: ServerControlMessage`):
- `{type: "started", sessionId: string}`
- `{type: "not_found"}`
- `{type: "error", message: string}`
- `{type: "exit", code: number}`
- raw PTY output chunks (plain text, no envelope)

The server (`createApp.ts`) parses messages as `any` and switches on
`message.type` by hand — it does not import the client's union type. Keep both
sides in sync manually when adding a message type.

## Socket-send guard

Both client (`useWebSocket.ts: send`) and server (`session.socket?.send`)
must check the socket is open before writing:
- Client: `socketRef.current?.readyState === WebSocket.OPEN`
- Server: optional-chain on `session.socket` (set to `null` on detach)

## Error handling

- Nonexistent working directory: checked before spawn (`existsSync`), replies
  `error`, never spawns.
- Spawn failure: caught, reported via `error` — no silent hang.
- Process exit: server sends `exit`, removes the session immediately (nothing
  to resume).
- Per-session PTY/session errors must not crash the whole Node process.

## Testing

- Server: Vitest (`server/test/*.test.ts`) covers `createSession` cwd
  validation, grace-timer PTY kill (no leaked processes), and
  `attachSession` replay/timer-cancel behavior. Run with `npm test -w server`.
- Client: no automated test suite for v1 — verify terminal behavior manually
  (see CLAUDE.md Non-Negotiables).
