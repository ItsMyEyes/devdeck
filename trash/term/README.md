# Claude Code Web Controller

Local web UI that starts and controls a real Claude Code CLI session through
a browser terminal.

## Run

    npm install
    npm run dev

This starts the server (`http://127.0.0.1:8787`) and the client
(`http://localhost:5173`) together. Open the client URL, enter a working
directory, and click Start.

## Environment variables (server)

- `PORT` - server port (default 8787)
- `SESSION_GRACE_MS` - how long a session survives after a dropped
  connection before being killed (default 300000 = 5 minutes)
- `CLAUDE_COMMAND` - override the Claude Code CLI command (default `claude`,
  or `claude.cmd` on Windows)
