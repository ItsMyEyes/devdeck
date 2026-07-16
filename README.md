# Loom

> One operator, many companies. A multi-project dashboard for coding agents — git worktrees + real terminals, in the browser.

Loom lets a single operator run several codebases across several client workspaces from one dashboard: spin up a git worktree, attach a coding agent to it in a real PTY terminal, edit files with LSP-backed intelligence, review the diff, and track the work as kanban issues — without leaving the browser. It also handles the business side of running client work: todos, invoices (with recurring billing and finance reporting), and a news feed.

New here? Start with **[TUTORIAL.md](TUTORIAL.md)** for a full walkthrough from `git clone` to your first agent worktree.

## Features

- **Workspaces → Projects → Worktrees.** A workspace groups a client's projects; each project holds branch-mode worktrees (a real `git worktree` checkout with a coding agent attached) and root-mode worktrees (a plain shell at the project root, no agent).
- **Five coding agents out of the box** — Claude Code, Codex, Gemini CLI, Pi, and OpenCode — detected from your `$PATH`, with per-agent skills, MCP server, and env-profile management built in.
- **In-app editor with real LSP support** (CodeMirror 6 + `gopls` / `typescript-language-server` / `pyright` / `rust-analyzer`): autocomplete, diagnostics, go-to-definition, right next to the terminal.
- **Git panel** — status, diff, stage/unstage, discard, commit, push, pull — scoped to the worktree you're in.
- **Issue tracker** — a drag-and-drop kanban board per project (attachments, comments, an auto-recorded activity log), plus a standalone MCP server so an agent working in a worktree can file and update its own issues.
- **Invoices, Todos, News** — per-workspace, with recurring invoice templates and a finance-analysis view.
- **Tools page** — document → Markdown (`markitdown`) and Markdown → Word/PDF (`pandoc`, with Mermaid diagrams rendered inline), plus a handful of everyday dev utilities (JWT/Base64/hash/UUID/etc).
- **Multi-machine, or all-in-one.** Split into a **hub** (organizational data — workspaces, projects, invoices, the machine registry) and any number of **runtime** machines (execution — git, worktrees, terminals, LSP), talking directly to each other over one Tailscale tailnet, with self-registration so a runtime can add itself with no manual step; or run solo with one `--role both` process, or the desktop app, which can also self-register your own machine as a runtime against a hub you host elsewhere — see [TUTORIAL.md](TUTORIAL.md#13-deployment-modes-hub-both-and-desktop).

## Quick start

**Prerequisites:** Go 1.25+, Node.js 22+, git. A coding-agent CLI (`claude`, `codex`, `gemini`, `pi`, or `opencode`) is only needed to actually spawn an agent — the app runs fine without one.

```bash
git clone https://github.com/ItsMyEyes/enginer-workspaces.git
cd enginer-workspaces
make install   # frontend deps (npm install)
make dev       # frontend (:5173) + backend (:8989)
```

Then open **http://localhost:5173**.

> `make dev` also tries to run `tailscale serve --bg 5173` so the dev UI is reachable from another device on your tailnet. If you don't have Tailscale installed, run `cd frontend && npm run dev` instead — same result, no Tailscale dependency.

## Documentation

| Doc | What's in it |
|---|---|
| [TUTORIAL.md](TUTORIAL.md) | Step-by-step walkthrough: install, register, your first workspace/project/worktree, issues, agent config, tools, multi-machine setup, troubleshooting. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Stack, request flow, hub/runtime roles (with diagrams), directory map, feature implementation order. |
| [CONTRACTS.md](CONTRACTS.md) | Mandatory API/code contracts — error envelope, store interface, key-auth rules, machines API. |
| [COMMANDS.md](COMMANDS.md) | Every CLI flag and make target, exact commands for every workflow (dev, build, release, Tools module setup). |
| [ORCHESTRATION.md](ORCHESTRATION.md) | Multi-agent orchestration conventions for this repo. |

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8, TypeScript 5.7, TanStack Router, @base-ui/react, Tailwind v4, zustand, @tanstack/react-query, xterm.js, CodeMirror 6 |
| Backend | Go 1.25, stdlib `net/http`, SQLite (`modernc.org/sqlite`, no CGO), `nhooyr.io/websocket`, `go-pty` |

## Repository layout

```
backend/   Go server — cmd/server (main binary), cmd/mcp-server (issue-tracker MCP server), internal/*
frontend/  React SPA — src/routes (TanStack Router), src/features, src/lib, src/store
docs/      Design specs and implementation plans (docs/superpowers/)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full directory map.
