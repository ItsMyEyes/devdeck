# DevDeck

> One operator, many companies. A multi-project dashboard for coding agents — git worktrees + real terminals, in the browser.

DevDeck lets a single operator run several codebases across several client workspaces from one dashboard: spin up a git worktree, attach a coding agent to it in a real PTY terminal, edit files with LSP-backed intelligence, review the diff, and track the work as kanban issues — without leaving the browser. It also covers the small stuff around that work: per-workspace todos and a news feed.

New here? Start with **[TUTORIAL.md](TUTORIAL.md)** for a full walkthrough from `git clone` to your first agent worktree, or skim **[How it works](#how-it-works)** below for the 90-second version.

## How it works

1. **Create a workspace.** One per client or team — everything else nests under it.
2. **Add a project.** Point at a local folder or paste a GitHub URL; DevDeck clones it and you pick which machine runs it.
3. **Spawn a worktree.** Give it a branch name, a base branch, and — optionally — a coding agent and model. DevDeck runs a real `git worktree add` under the hood, so your main checkout is never touched.
4. **Work in the tiling workspace.** The screen becomes a canvas of resizable panes: a live terminal attached to the agent's PTY, a file explorer, an LSP-backed editor, and a git panel — split, stack, and arrange however you like. Navigate away and back and you reattach to the same running process; nothing restarts.
5. **Review and ship.** Watch the diff build up in the git panel, stage/commit/push without leaving the tab, and track the work as a kanban issue the agent can file and update itself through the built-in MCP server.

Clone → worktree → agent → review → merge — repeat across as many projects and clients as you're juggling, all from one dashboard.

## Features

- **Workspaces → Projects → Worktrees.** A workspace groups a client's projects; each project holds branch-mode worktrees (a real `git worktree` checkout with a coding agent attached) and root-mode worktrees (a plain shell at the project root, no agent).
- **Five coding agents out of the box** — Claude Code, Codex, Gemini CLI, Pi, and OpenCode — detected from your `$PATH`, with per-agent skills, MCP server, and env-profile management built in.
- **In-app editor with real LSP support** (CodeMirror 6 + `gopls` / `typescript-language-server` / `pyright` / `rust-analyzer`): autocomplete, diagnostics, go-to-definition, right next to the terminal.
- **Git panel** — status, diff, stage/unstage, discard, commit, push, pull — scoped to the worktree you're in.
- **Issue tracker** — a drag-and-drop kanban board per project (attachments, comments, an auto-recorded activity log), plus a standalone MCP server so an agent working in a worktree can file and update its own issues.
- **Todos & News** — a lightweight per-workspace task list and update feed, so the small stuff doesn't need a separate tool.
- **Tools page** — document → Markdown (`markitdown`) and Markdown → Word/PDF (`pandoc`, with Mermaid diagrams rendered inline), plus a handful of everyday dev utilities (JWT/Base64/hash/UUID/etc).
- **Multi-machine, or all-in-one.** Split into a **hub** (organizational data — workspaces, projects, the machine registry) and any number of **runtime** machines (execution — git, worktrees, terminals, LSP), talking directly to each other over one Tailscale tailnet, with self-registration so a runtime can add itself with no manual step; or run solo with one `--role both` process, or the desktop app, which can also self-register your own machine as a runtime against a hub you host elsewhere — see [TUTORIAL.md](TUTORIAL.md#13-deployment-modes-hub-both-and-desktop).

## Coming soon

- **Database module** — an in-app SQL client scoped to a worktree: object tree, editable table grid, DDL view, SQL editor, and CSV/SQL import-export — so you can inspect the schema your agent just touched without leaving DevDeck.
- **Invoices** — per-workspace billing: draft invoices with dynamic line items, company/bank presets, recurring templates that auto-generate monthly, and a finance-analysis rollup.

Both already have working UIs behind the scenes — they're being hardened before they're front and center.

## Install

One command, no toolchain — downloads the release binary for your platform.

```bash
# Linux / macOS
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | GITHUB_TOKEN=ghp_xxx sh
```

```powershell
# Windows
$env:GITHUB_TOKEN="ghp_xxx"; irm https://kiyora.is-a.dev/devdeck/install.ps1 | iex
```

Add `DEVDECK_HUB_URL` and `DEVDECK_HUB_KEY` to the same command to register the
machine as a runtime against an existing hub in one step:

```bash
curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh | \
  GITHUB_TOKEN=ghp_xxx DEVDECK_HUB_URL=https://hub.ts.net DEVDECK_HUB_KEY=hubk sh
```

`GITHUB_TOKEN` is required because this repository is private — create a
fine-grained token with **Contents: read**. The scripts are served from the
public docs site, so you can read one before piping it. Full options:
[`scripts/README.md`](scripts/README.md).

> **Until the first release is published**, the Pages URL and the release assets
> do not exist yet. Fetch the script straight from the repo instead:
> `curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/ItsMyEyes/devdeck/main/scripts/install.sh | GITHUB_TOKEN=$GITHUB_TOKEN sh`
> Delete this note once `kiyora.is-a.dev/devdeck/install.sh` resolves.

Building from source instead:

### From source

**Prerequisites:** Go 1.25+, Node.js 22+, git. A coding-agent CLI (`claude`, `codex`, `gemini`, `pi`, or `opencode`) is only needed to actually spawn an agent — the app runs fine without one.

```bash
git clone https://github.com/ItsMyEyes/enginer-workspaces.git
cd enginer-workspaces
make install   # frontend deps (npm install)
make dev       # frontend (:5173) + backend (:8989)
```

Then open **http://localhost:5173**.

> `make dev` also tries to run `tailscale serve --bg 5173` so the dev UI is reachable from another device on your tailnet. If you don't have Tailscale installed, run `cd frontend && npm run dev` instead — same result, no Tailscale dependency.

**Running a release binary instead?** Configure it once with the wizard:

```bash
./devdeck setup   # step-by-step; writes devdeck.yaml, then start with ./devdeck
```

It covers every deployment mode (hub, runtime, or both), generates your API key, pre-fills a runtime's public URL from Tailscale, verifies your hub URL and key before saving, and prints the `name|url|key` line you paste into the hub's Machines page. Every setting lands in one `devdeck.yaml` ([template](devdeck.yaml.example)); flags and `DEVDECK_*` env vars still work and override it. See [TUTORIAL.md §13](TUTORIAL.md#13-deployment-modes-hub-both-and-desktop).

### macOS: "DevDeck is damaged / can't be opened"

The desktop app is currently **ad-hoc signed** (not notarized with an Apple Developer ID). When you download it through a browser, macOS attaches a `com.apple.quarantine` flag to the bundle and Gatekeeper refuses to launch it — usually shown as *"DevDeck is damaged and can't be opened"* or *"can't be opened because it is from an unidentified developer."* The app itself is fine; the quarantine flag is what's blocking it.

Strip the flag and open it:

```bash
xattr -dr com.apple.quarantine /Applications/DevDeck.app
open -a /Applications/DevDeck.app
```

This applies to every fresh download/re-install. As a one-off alternative you can right-click the app in Finder → **Open** → **Open anyway** to bypass Gatekeeper once, but the `xattr` command is cleaner and works every time. You'll need to redo it after each new download until the release is notarized.

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

## License

MIT — see [LICENSE](LICENSE). Third-party dependency licenses are noted in [NOTICE](NOTICE).

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.
