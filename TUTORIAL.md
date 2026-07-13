# Tutorial

A walkthrough from a fresh clone to your first agent worktree, then a tour of everything else Loom does. See [README.md](README.md) for the one-paragraph pitch and [COMMANDS.md](COMMANDS.md) for the exhaustive flag/command reference this tutorial links out to.

## 1. Prerequisites

| Tool | Version | Required for |
|---|---|---|
| Go | 1.25+ | running/building the backend |
| Node.js | 22+ | running/building the frontend |
| git | any recent version | cloning, and Loom's own worktree management |
| A coding-agent CLI (`claude`, `codex`, `gemini`, `pi`, or `opencode`) | any | only for spawning an agent in a worktree — optional, the app runs fine without one |
| Tailscale CLI | any | only for `make dev`'s tailnet-serve convenience, and for multi-machine setups — optional for plain local dev |

## 2. Install and first run

```bash
git clone https://github.com/ItsMyEyes/enginer-workspaces.git
cd enginer-workspaces
make install   # == cd frontend && npm install
make dev       # frontend :5173 + backend :8989
```

If `make dev` fails immediately with something about `tailscale`, you don't have the Tailscale CLI installed — run `cd frontend && npm run dev` instead, which does exactly the same thing minus the tailnet-serve step.

Open **http://localhost:5173**. Nothing is seeded — a fresh clone has no database file and no user account, so you'll land on the login screen with nowhere to go but **Register**.

Optional one-time step: `git config core.hooksPath .githooks` enables a pre-commit hook that runs the frontend typecheck before every commit.

## 3. Create your account

Click through to **Register** and enter an email and a password (12+ characters). What happens next depends on how you started the backend:

- Via `make dev` (or `npm run dev`) — the bundled `dev:api` npm script passes `--2fa=false`, so registration logs you straight in. No TOTP setup.
- Via `make dev-api` or `make dev-hub` — these run with the default `--2fa=true` (matching production), so after registering you're sent to a **2FA setup** screen: scan the QR code with an authenticator app (Google Authenticator, Authy, 1Password, …), enter the 6-digit code to confirm, and save the one-time backup codes shown on screen (you won't see them again — they're your recovery path if you lose the authenticator). From then on, logging in is a two-step form: email/password, then a 6-digit code (or a backup code).

Either way, you land on `/` — which, with no workspace yet, shows an onboarding screen prompting you to create one.

## 4. Your first workspace and project

A **workspace** is the top-level grouping — think "one client" or "one team." A **project** is a single repo living inside a workspace.

1. Create a workspace (name only) from the onboarding screen or the workspace switcher at the top of the sidebar.
2. Add a project: point it at a local folder (a folder picker browses the filesystem of whichever machine the project will run on) or clone a GitHub URL directly. If you've registered more than one machine (see [§13](#13-multi-machine-setup)), you'll also pick which machine this project's files should live on — leave it unassigned for "this machine."
3. The project now appears in the sidebar's project tree, with **Worktrees** and **Issues** tabs.

## 5. Spawn your first agent worktree

From the project's **Worktrees** tab, click spawn and choose **branch mode**:

- **Branch name** — a new branch to check out (Loom runs a real `git worktree add` under `<project>/.wt/<worktree-id>`, so your main checkout is never touched).
- **Base branch** — which existing branch to branch from.
- **Task** — a short description; if an agent is attached, this is passed to it as its initial prompt.
- **Agent / Model** — pick from whichever agent CLIs Loom detected on your `$PATH` (see [§11](#11-agent-management)). If you don't have any installed yet, you can still spawn one — it just won't have an agent binary to launch, and Loom falls back to a plain shell.

The new worktree shows up as a live card (running / waiting / error, with token and diff stats once the agent starts working). Click it to open the full terminal view.

## 6. Working inside a worktree

Opening a worktree switches the whole screen into a **tiling workspace**: the top header disappears, the sidebar collapses to a ~44px icon rail (back arrow, workspace badge, nav icons — the only way back once the header's gone), and the rest of the viewport becomes a canvas of resizable panes. Every pane can hold one of four content kinds:

- **Terminal** — the real PTY the agent (or shell) is running in, backed by a live WebSocket. Navigate away and back and you reattach to the *same* running process — nothing restarts. A worktree always starts with one Terminal pane; splitting a Terminal pane spins up a genuinely independent second PTY (its own shell/agent, no shared echo).
- **File explorer** — a tree of the worktree's files, with a quick-open search (`Ctrl/Cmd-P`) and new-file/delete actions.
- **Editor** — click any file to open it in a CodeMirror tab. Every common language gets syntax highlighting; Go, TypeScript/JavaScript, Python, and Rust additionally get real language-server intelligence (autocomplete, inline diagnostics, `Ctrl/Cmd`-click go-to-definition) if `gopls` / `typescript-language-server` / `pyright-langserver` / `rust-analyzer` respectively are on your `$PATH`. `Ctrl/Cmd-S` saves; `Ctrl/Cmd-W` closes the active file tab.
- **Git panel** — status, diff, stage/unstage/discard, commit, push, pull, scoped to this worktree's branch.

**Splitting and arranging panes:** each pane has a small header with its own tab strip (stack several tabs in one pane without splitting), "split right" / "split down" buttons, and — when the pane is focused — a "..." overflow menu. Drag a tab and drop it near a pane's edge to split in that direction, or onto its center to merge it in as another tab in that pane. Your layout (which panes, which tabs, split sizes) is remembered per worktree, so it reopens exactly as you left it. On phone-width screens, panes stack one full-bleed at a time instead of tiling side by side, and drag-and-drop is disabled.

**The "..." overflow menu** (on the focused pane, when its active tab is a Terminal) has:
- **Approve** — only shown while the worktree is waiting on you.
- **Open Git panel** / **Open file explorer** — add or focus that pane kind, since a fresh worktree starts with only a Terminal pane.
- **Details** — edit the worktree's branch, task, or model (same drawer as the sidebar's edit action).
- **Delete** — removes both the DB row and the on-disk `git worktree` (the agent process is stopped first).

## 7. Root-mode terminal

Sometimes you just want a shell at the project root — no branch, no agent. Spawn a worktree in **root mode** instead (same dialog, different tab) and you get a plain terminal `cd`'d into the project's own path. It shows up with a house icon everywhere a branch worktree would show a branch icon, and deleting it never touches git (there's nothing to remove — it's the project's own checkout).

## 8. Issues

Each project has an **Issues** tab: a drag-and-drop kanban board across four columns (To Do / In Progress / In Review / Done). Open an issue to:

- Edit its title, Markdown description, assignee, status, and priority inline.
- Upload attachments (images render as thumbnails).
- Post comments and single-level replies, interleaved chronologically with an auto-recorded activity log (status/priority/assignee changes show up here automatically — you don't create these, Loom does).

An agent working in a worktree can file and update these issues itself — see [§14](#14-mcp-issue-tracker-server-for-agents).

## 9. Todos and News

Both are workspace-scoped and fully functional (add/toggle/filter/delete for Todos; unread tracking and a tagged feed for News) — reach them at `/w/<workspace-id>/todos` and `/w/<workspace-id>/news`. They aren't currently linked from the sidebar navigation, so bookmark the URL or type it directly.

## 10. Invoices

The **Invoices** tab (linked from the sidebar) has three views:

- **Invoices** — a month-grouped table. Create a draft with dynamic line items, pick (or save) a **Company** (client billing preset) and **Bank** (payout account preset) to prefill the payee block, mark it paid, download it as a document, or delete it.
- **Recurring** — save a billing snapshot as a template that auto-generates a new draft invoice every month on a configured day.
- **Finance Analysis** — an aggregate view across your invoices.

## 11. Agent management

The **Agent management** sidebar item is where you configure the coding agents themselves, per agent:

- **Models** — the built-in catalog per agent, merged with any custom model aliases you've configured locally for that CLI.
- **Skills** — install a skill into an agent's real skill directory (e.g. `~/.claude/skills`) or remove one; read-only bundled skills can't be removed.
- **MCP servers** — Claude and Codex only. Add a `stdio` (command + args + env) or `http` (URL) MCP server; values are redacted after saving.
- **Env profiles** — Claude and Codex only. Save a named "LLM endpoint" snapshot (base URL, auth token, model-alias slots, extra env vars) and activate it to point that agent at an alternate/self-hosted endpoint — useful if you're routing through a proxy instead of talking to the vendor directly. There's also a raw settings-file editor (`settings.json` for Claude, `config.toml` for Codex) if you need to hand-edit something the UI doesn't expose yet.

## 12. Tools

The **Tools** sidebar item is a workspace-agnostic utility page. The two document-conversion tools shell out to external CLIs (see [COMMANDS.md's "Tools module setup"](COMMANDS.md#tools-module-setup-markitdown-pandoc-mermaid) for install commands — if a binary is missing, the UI shows a 503 with the exact install command instead of failing silently):

- **Document → Markdown** — upload a PDF/Word/PowerPoint/Excel/image/audio/HTML file (25MB cap), get back editable Markdown. PDFs get layout-aware extraction; if `OPENAI_API_KEY` + `MARKITDOWN_LLM_MODEL` are set (see `backend/.env.example`), images get LLM-generated descriptions automatically.
- **Markdown → Document** — write or paste Markdown, export to `.docx` or `.pdf`. Any ` ```mermaid ` fenced code block is rendered to a PNG first and inlined, so diagrams show up in the exported document.

The rest of the page is everyday dev utilities: JWT decode, Base64, URL encode/decode, hashing, JSON/XML/CSV formatting, UUID generation, timestamp conversion.

## 13. Multi-machine setup

By default everything runs as a single **hub** — one process holding both the organizational data (workspaces/projects/invoices/…) and doing the execution work (git/worktrees/terminals) itself. If you want a second machine to handle execution — more CPU, a different OS, a machine physically closer to a particular repo — register it as a **runtime**.

**Manually**, from the hub's **Machines** page: add a machine's name, URL, and a static key. The hub then talks to it directly (or falls back to proxying through itself if a direct connection fails) and distributes that key to your browser for direct connections.

**Automatically**, a runtime can register itself — no manual step in the Machines UI. Locally, this is exactly what `make dev-runtime` does:

```bash
make dev-hub       # terminal 1 — hub on :8989, with a fixed dev bearer key
make dev-runtime   # terminal 2 — runtime on :9199, self-registers with the hub above
```

Open the Machines page and the runtime is already there. For a real two-machine setup (both on the same Tailscale tailnet), the equivalent is:

```bash
# on the runtime machine:
go run ./cmd/server --role runtime --key <runtime-key> --addr <runtime-tailnet-ip>:8989 \
  --hub-url https://hub.<your-tailnet>.ts.net --hub-key <hub-key> \
  --public-url https://this-machine.<your-tailnet>.ts.net --name my-runtime
```

See [ARCHITECTURE.md's "Hub / runtime roles"](ARCHITECTURE.md#hub--runtime-roles) for the full request-flow diagrams, and `docs/superpowers/specs/2026-07-09-runtime-self-registration-design.md` for exactly how the self-registration handshake works.

Once a project is assigned to a runtime machine, every worktree/terminal/LSP/git operation for that project's worktrees runs on that machine — the hub just federates the data into the same UI you already know.

## 14. MCP issue-tracker server for agents

`backend/cmd/mcp-server` is a separate binary that exposes Loom's issues to a coding agent over MCP (stdio) — handy for having the agent working *inside* a worktree file its own tickets against the same project. It opens the same SQLite `--db` file the main server uses (safe to share, WAL mode).

```bash
make build-mcp   # writes backend/loom-mcp-server
```

Point an MCP client at it (e.g. in a worktree's own `.mcp.json`):

```json
{
  "mcpServers": {
    "loom-issues": {
      "command": "/path/to/loom-mcp-server",
      "args": ["--db", "/path/to/loom.db"]
    }
  }
}
```

It exposes four tools: `list_projects`, `create_issue` (assignee is required — the agent should ask if it isn't obvious), `upload_attachment` (attaches a local file and, by default, appends a link/embed to the issue's description), and `mark_issue_done` (moves the issue to **In Review** — a human still does the final close).

## 15. Troubleshooting

- **`make dev` fails immediately, mentions `tailscale`.** You don't have the Tailscale CLI installed. Run `cd frontend && npm run dev` instead.
- **Port already in use.** `make free-ports` kills whatever's listening on `8989`, `5173`, and `9199` (frontend, hub, and the `dev-runtime` port).
- **A worktree opens to a plain shell instead of an agent.** The agent CLI you picked isn't on the backend process's `$PATH` (or its login-shell `$PATH` — Loom checks both). Install it, or pick a different agent.
- **Tools page shows a 503 for a conversion.** The underlying CLI (`markitdown`/`pandoc`/`mmdc`) isn't installed — the error message includes the exact install command. See [COMMANDS.md](COMMANDS.md) for the full setup.
- **Lost your 2FA device.** Use one of the one-time backup codes shown at enrollment. If you don't have those either, there's no self-service recovery — you'd need direct database access to clear the account's TOTP secret.
- **A registered machine shows offline.** The hub polls `GET /api/machines/{id}/health` with a 3-second timeout — check the runtime process is actually running and reachable on the URL you registered it with, and that both machines are on the same tailnet if you're not on `127.0.0.1`.
