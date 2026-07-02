# loom

> one operator · many companies

A multi-project dashboard for running coding agents across git worktrees, with a
real terminal per worktree. Built from the **Loom v2** design.

This is the **core** build: the agents dashboard (workspaces → projects →
worktrees), the worktree cards, and the expanded **xterm.js** terminal, plus the
workspace switcher, creation flows, details drawer and delete confirmation, and
the News / Todos / Invoices modules.

Domain data (workspaces, projects, worktrees, news, todos, invoices) is served
by a **Go + SQLite REST backend** and flows through **@tanstack/react-query** —
the backend is the source of truth. zustand now holds only transient UI state.

## Stack

- **React 19 + Vite + TanStack Router** (file-based routes)
- **@base-ui/react** headless components + **Tailwind v4** (shadcn-style layer)
- **@tanstack/react-query** for all server/domain data
- **zustand** for transient UI state (drafts, dialogs, menus)
- **Go (stdlib net/http) + SQLite** (`modernc.org/sqlite`, pure Go) REST backend
- **xterm.js** wired to a **WebSocket ↔ Go PTY/ConPTY** gateway
- **sonner** toasts, **lucide-react** icons

## Prerequisites

- Node 22+
- Go 1.25+ (for the REST backend)

## Install

```bash
cd frontend
npm install
```

The Go terminal gateway uses native Unix PTYs on macOS/Linux and ConPTY on
Windows 10 version 1809 or newer. If a native PTY cannot be created, the
terminal falls back to a self-contained simulated stream.

## Develop

```bash
npm run dev
```

This runs two processes concurrently:

- **web** — Vite on <http://localhost:5173>
- **api** — the Go + SQLite REST and terminal WebSocket backend on
  <http://localhost:8989> (proxied by Vite at `/api` and `/ws/terminal`)

Open <http://localhost:5173>. Expand any worktree to get a live native terminal;
in locked-down environments you get the simulated stream.

Run a single process alone with `npm run dev:web` / `npm run dev:api`.

## Backend (Go + SQLite)

The REST API lives in [`backend/`](backend/) and is a pure-Go
(`modernc.org/sqlite`, no CGO) stdlib `net/http` server. See
[`backend/README.md`](backend/README.md) for full details.

```bash
npm run dev:api        # backend with project-local development database
npm run build:api      # production Go binary with embedded frontend
```

- Serves `/api/*` (proxied through Vite in dev; set `VITE_API_BASE` to point
  elsewhere).
- Listen address from `-addr` flag / `LOOM_ADDR` env (default
  `127.0.0.1:8989`); SQLite path from `-db` flag / `LOOM_DB` env (default
  `data/loom.db` beside the portable executable).
- **The database starts EMPTY** — there is no auto-seed. On first run the app
  shows empty states everywhere.
- Load the demo dataset (two workspaces with projects, worktrees, news, todos
  and invoices) on demand via `POST /api/seed`, which wipes all tables and
  reinserts the demo data. The UI exposes this from the onboarding / empty
  screens.

## Build & check

```bash
make build          # host binary with embedded production UI
make portable       # portable binary for the current platform
make portable-all   # macOS/Linux/Windows, amd64 + arm64
npm run typecheck   # tsc --noEmit
```

## Architecture

```
src/
├─ routes/            TanStack file-based routes (URL = scope)
│   /                       → redirect to active workspace
│   /w/$wsId                → app shell (header + sidebar + overlays)
│   /w/$wsId/p/$projectId   → worktree cards (breadcrumb layout)
│   …/wt/$wtId              → expanded xterm terminal
│   /w/$wsId/{news,todos,invoices} → backend-backed module views
├─ store/             zustand store — transient UI state only (drafts, dialogs)
├─ features/data/     react-query hooks + query keys over the REST API
├─ components/ui/     shadcn-style primitives over @base-ui/react
├─ features/          Header, Sidebar, ProjectTree, WorktreeCard, Terminal, overlays…
└─ lib/               formatters, color constants, terminal WS client, api client
backend/
└─ …                     Go + SQLite REST API (see backend/README.md)
server/
└─ terminal-server.mjs   WebSocket ↔ node-pty gateway (JS fallback)
```

State scope lives in the URL (workspace → project → worktree). Domain data is
fetched from the Go backend through react-query (`qk.workspaces` / `qk.settings`
are the source of truth); the zustand store holds only ephemeral UI (menus,
dialogs, drafts). Every data surface renders explicit loading, error and empty
states.

### Terminal protocol

```
client → server : {"t":"i","d":"…"}            stdin
                  {"t":"r","cols":N,"rows":N}  resize
server → client : raw terminal output          (written straight into xterm)
```
