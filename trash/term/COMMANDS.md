# Commands

> Referenced from CLAUDE.md. npm workspaces monorepo (`server`, `client`).

## Run

```
npm install
npm run dev        # runs server (:8787) and client (:5173) together
```

## Server (`server/`)

```
npm run dev -w server     # tsx watch
npm run build -w server   # tsc -p tsconfig.json
npm run start -w server   # node dist/index.js
npm test -w server        # vitest run
```

## Client (`client/`)

```
npm run dev -w client       # vite
npm run build -w client     # tsc -b && vite build
npm run lint -w client      # oxlint
npm run preview -w client   # vite preview
```

## Environment variables (server)

- `PORT` — server port (default 8787)
- `SESSION_GRACE_MS` — grace period before an unattached session's PTY is
  killed (default 300000 = 5 minutes)
- `CLAUDE_COMMAND` — override the resolved Claude Code CLI command
