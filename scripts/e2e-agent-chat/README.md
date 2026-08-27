# Agent-chat composer E2E

A real-browser check of the chat composer's controls against an isolated
DevDeck server, with a fake `claude` CLI so no API tokens are spent and the
flags each session was launched with are observable.

```bash
python3 scripts/e2e-agent-chat/run.py          # or: make e2e-agent-chat
```

What it proves (each is a `PASS`/`FAIL` line; see `run.py`'s docstring):

- The Permission pill reflects the **thread's** mode after a reload (it is
  replayed from the event log), including a mode picked before the first
  message.
- Reasoning / Context Window picks reach the CLI: the session is restarted
  with `--effort …` (never with `--resume` on a first turn; always with it
  once a conversation exists), and an unchanged pick does not restart.
- Reasoning survives a reload (persisted per thread).
- No Build/Plan pill; `/plan` and `/build` are the way to switch.
- An invalid mode over the socket is rejected with an error frame.

`fake-claude` speaks just enough stream-json for the claude adapter and the
model probe; every reply echoes `effort=… mode=… resumed=…`. Its argv per
spawn goes to `$FAKE_CLAUDE_LOG`.

Requires Go, Node (frontend deps installed), and Python Playwright with
Chromium. Ports: `DEVDECK_E2E_API_PORT` (8977), `DEVDECK_E2E_VITE_PORT`
(5177). Artifacts (screenshots, server/vite logs, argv log) go to
`$DEVDECK_E2E_OUT` or a fresh temp dir printed at the end.
