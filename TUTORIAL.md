# Tutorial

A walkthrough from a fresh clone to your first agent worktree, then a tour of everything else DevDeck does. See [README.md](README.md) for the one-paragraph pitch and [COMMANDS.md](COMMANDS.md) for the exhaustive flag/command reference this tutorial links out to.

## 1. Prerequisites

| Tool | Version | Required for |
|---|---|---|
| Go | 1.25+ | running/building the backend |
| Node.js | 22+ | running/building the frontend |
| git | any recent version | cloning, and DevDeck's own worktree management |
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
2. Add a project: point it at a local folder (a folder picker browses the filesystem of whichever machine the project will run on) or clone a GitHub URL directly. You'll also pick which registered **Machine** runs it — a brand-new hub starts with none, so if the dropdown is empty see [§13](#13-deployment-modes-hub-both-and-desktop) first (fastest fix: restart with `--role both`, which registers itself automatically).
3. The project now appears in the sidebar's project tree, with **Worktrees** and **Issues** tabs.

## 5. Spawn your first agent worktree

From the project's **Worktrees** tab, click spawn and choose **branch mode**:

- **Branch name** — a new branch to check out (DevDeck runs a real `git worktree add` under `<project>/.wt/<worktree-id>`, so your main checkout is never touched).
- **Base branch** — which existing branch to branch from.
- **Task** — a short description; if an agent is attached, this is passed to it as its initial prompt.
- **Agent / Model** — pick from whichever agent CLIs DevDeck detected on your `$PATH` (see [§11](#11-agent-management)). If you don't have any installed yet, you can still spawn one — it just won't have an agent binary to launch, and DevDeck falls back to a plain shell.

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
- Post comments and single-level replies, interleaved chronologically with an auto-recorded activity log (status/priority/assignee changes show up here automatically — you don't create these, DevDeck does).

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

## 13. Deployment modes: hub, both, and desktop

> Adding a runtime machine to an existing hub is one command — see
> [Install](README.md#install). The rest of this section covers what the modes
> mean and how to configure them by hand.

DevDeck is one binary (plus an optional native desktop shell around it), run in different shapes depending on your situation — everything below builds on the single-hub setup from §§1-8. Skip to [§13.5](#135-which-one-should-i-use) for a one-line recommendation, or read on for how each mode actually works.

### The fastest path: `devdeck setup`

Every mode below can be configured by hand with flags, and all of those flags still work. But you don't have to assemble them — run the wizard once and it writes a `devdeck.yaml` holding every setting:

```bash
./devdeck setup
```

It walks you through it step by step: role, machine name, listen address, database path, an API key it generates for you, and (for a runtime) your public URL, which it pre-fills by asking Tailscale for this device's tailnet name. If you give it a hub URL and key, it checks them live against the hub's `/api/whoami` **before** writing anything, so a wrong key fails right there instead of silently surfacing as "Never synced with the hub" half a minute after boot. Nothing is written until you confirm the review screen; `ctrl+c` before that leaves the disk untouched.

For a runtime it finishes by printing the line you paste into the hub (§13.2), and saves the same line to `copy-this.md` beside the config:

```
  builder|https://builder.tail-abc.ts.net|a1b2c3d4…
```

Re-running `devdeck setup` later pre-fills every answer from the existing file, so it doubles as the reconfigure path.

Starting the binary on a machine with no `devdeck.yaml` opens the same wizard automatically — **unless** there's no terminal attached (a systemd or launchd service, the desktop sidecar, CI), in which case it writes a commented defaults file, logs where it put it, and boots normally. A background service never blocks waiting for an answer nobody can give.

Precedence, lowest to highest: **built-in default → `devdeck.yaml` → `DEVDECK_*` env var → command-line flag.** The file is a baseline you can always override for a single run without editing it. `--config <path>` (or `DEVDECK_CONFIG`) names a specific file; otherwise DevDeck looks for `./devdeck.yaml`, then `devdeck.yaml` beside the binary. A commented template of every key lives at [`devdeck.yaml.example`](devdeck.yaml.example). A key that isn't in that template is a hard error at startup, so a typo stops the server instead of silently doing nothing.

`devdeck.yaml` and `copy-this.md` both contain a live API key. Both are written mode `0600` and both are gitignored — keep them that way.

### The one rule that applies to every mode: a project needs a Machine

Every project is executed by a registered **Machine** (git/worktrees/terminals/LSP all run there) — you pick which one in the **New project** dialog's machine dropdown. A brand-new hub (`--role hub`, the default — what `make dev` runs) starts with an *empty* Machines registry, so that dropdown has nothing but "Select a machine…" in it, and you can't create a project yet. Every mode below is really just a different answer to "how does a Machine get into that registry" — from one extra flag to a whole second computer over Tailscale.

### 13.1 Solo, one computer — `--role both`

The simplest correct setup for a single operator on a single computer: one process does the organizational data *and* the execution work, and registers itself as a Machine on startup so you never have to touch the Machines page.

```bash
cd backend && go run ./cmd/server --role both --key <any-secret-string> --db devdeck.db
```

- Requires `--key`, same fail-fast rule as `--role runtime`.
- On startup it self-registers itself (marked `isLocal`), so **New project**'s machine dropdown auto-selects it immediately.
- Everything else — routes, auth, the UI — is identical to plain `--role hub` (§§1-12).
- Same idea for a release build: `./devdeck --role both --key <secret>` (see [COMMANDS.md's Build section](COMMANDS.md#build) for `make portable`).

### 13.2 Hub + one or more separate runtime machines

Register a second machine when you want more CPU, a different OS, or a machine physically closer to a particular repo to do the execution work. All git/worktree/terminal/LSP activity for a project assigned to that machine happens there; the hub only holds organizational data and federates everything into one UI.

From the hub's **Machines** page → **Add Runtime**, there are two ways to connect one:

- **Self-register command** (for a runtime you're setting up now). The dialog shows a ready-to-run command with a generated key and your hub's own URL already filled in:
  ```bash
  ./devdeck.exe --role runtime --key <generated> --addr 0.0.0.0:9199 --db runtime.db --open=false \
    --hub-url <your-hub-url> --hub-key <your-hub-key> --public-url http://<hostname>:9199 --name <name>
  ```
  Fill in `<your-hub-key>` (the hub's own `--key`) and `<hostname>` (this runtime's real reachable address), then run it on the target machine — it registers itself on startup. There's no submit button on the hub side; the machine just appears once it's registered.
- **Paste a connection string** (for a runtime that's already running). Click "Have a connection string instead?" and paste one `name|url|key` line (e.g. `builder|https://builder.tail-x.ts.net|a1b2c3...`). Unlike the self-register path, the hub verifies this immediately — it calls the runtime's `/api/whoami` with the given key before creating the row, so a wrong key or an unreachable URL fails right away with a clear error instead of silently registering a dead machine.

Either way ends the same: the machine shows up on the Machines page and becomes selectable in **New project**. Everything rides one Tailscale tailnet — hub and runtimes need to be on the same tailnet, and URLs should be the tailnet address (`https://<name>.<tailnet>.ts.net`), not `127.0.0.1`, once they're on different machines. See [ARCHITECTURE.md's "Hub / runtime roles"](ARCHITECTURE.md#hub--runtime-roles) for the full request-flow diagrams.

Locally, without any real second machine, `make dev-runtime` exercises the self-register path against `make dev-hub`:

```bash
make dev-hub       # terminal 1 — hub on :8989, with a fixed dev bearer key
make dev-runtime   # terminal 2 — runtime on :9199, self-registers with the hub above
```

### 13.3 Signing in directly to a runtime, and surviving a hub outage

Every `--role runtime` process serves its own copy of the web UI at its own address, and holds a read-only replica of its slice of the hub's catalog — so it stays usable for the projects assigned to it even while the hub is down. This walks through both.

**1. Start a hub and a runtime that self-registers with it.**

```bash
cd backend && go run ./cmd/server --role hub --key hubk --2fa=false --addr 127.0.0.1:8989 --db /tmp/hub.db --open=false
cd backend && go run ./cmd/server --role runtime --key rtk --addr 127.0.0.1:9199 --db /tmp/rt.db --open=false \
  --hub-url http://127.0.0.1:8989 --hub-key hubk --public-url http://127.0.0.1:9199 --name builder
```

**2. On the hub**, log in (or register, since `--2fa=false`) at `http://127.0.0.1:8989`, create a workspace, and add a project assigned to the `builder` machine (it now appears in the **New project** machine dropdown, since it self-registered).

**3. Watch the runtime pull it down.** The runtime polls the hub every 30s; its stdout logs `catalog sync: 1 workspace(s), 1 project(s), 0 ssh connection(s)` once the pull succeeds. You can also confirm it directly:

```bash
curl -s -H 'Authorization: Bearer rtk' http://127.0.0.1:9199/api/workspaces   # shows the same project, without going through the hub
```

**4. Open the runtime's own UI.** Visit `http://127.0.0.1:9199` in a browser — this is a separate address from the hub, and it now renders a sign-in page instead of a blank 401. Two ways in:

- **Paste the runtime's key** (`rtk` above) into the field and submit. This always works, including with the hub unreachable, since it only checks the key against this process.
- **"Sign in via hub"** button — shown only once the runtime has self-registered (it needs to know the hub's URL and its own hub-assigned machine id, both exposed via `GET /api/whoami`). Clicking it does a full top-level navigation to the hub's `/handover` route, which mints a short-lived signed token there (using your already-logged-in hub session) and redirects back to the runtime with `?t=<token>`. You land signed in without typing anything — effectively SSO from the hub session, inheriting whatever 2FA you already passed there.

Either path lands on the same UI as the hub, scoped to this runtime's own workspaces/projects.

**5. Prove the offline case.** Stop the hub process (`Ctrl-C` or `kill`), then reload the runtime's UI at `http://127.0.0.1:9199`. It keeps serving the last snapshot it pulled — the workspace and project from step 2 are still there — instead of going blank. This is the whole point of the replica: routine hub restarts/maintenance/network blips don't interrupt work already running on a runtime.

**One caveat to know about:** if a runtime has never successfully synced (wrong `--hub-key`, unreachable `--hub-url`, or you just haven't waited 30s yet), its sidebar shows a **"Never synced with the hub"** notice instead of a plain empty list — that distinction exists specifically so a misconfigured `--hub-key` doesn't look identical to "this account just has no projects." If you see that notice, check the runtime's own log output for `catalog sync: fetch: ...` or `catalog sync: apply: ...` errors.

A `--role both` process (§13.1) never does any of this — it *is* the hub, so there's nothing to sync from; visiting its own address just shows the normal hub UI directly.

### 13.4 Desktop app

DevDeck also ships as a native app (macOS/Windows/Linux, via Tauri) — `make dev-tauri` for development, `cd frontend && npm run tauri:build` for a release bundle (see [COMMANDS.md's "Desktop app (Tauri)"](COMMANDS.md#desktop-app-tauri) for exact build commands). The first launch asks how to run it — revisit the choice anytime from the app menu's **Change Hub…** item.

**Host locally on this device.** The app bundles the same Go backend as a background process (`--role hub`, ephemeral per-launch key, local SQLite database in the app's own data directory) — a complete, self-contained hub with nothing to configure. It registers itself automatically, exactly like `--role both` above, so **New project** works immediately.

**Connect to a hub I already host.** For pointing the desktop app at a hub running elsewhere (a home server, a cheap VPS, another DevDeck install), you provide:

- **Hub URL** — that hub's tailnet address (`https://hub.tail-x.ts.net`).
- **Hub key** — that hub's own `--key`.

The window then behaves like a plain browser tab logged into that hub — same login screen, same session. It also does one more thing in the background: it looks up this device's own Tailscale address and, if found, spawns the bundled backend as a second, separate `--role runtime` process that self-registers with the hub you pointed it at (fronted on the tailnet via `--enable-tailscale-serve`, so it's reachable at `https://<this-device>.<tailnet>.ts.net`, no port). In practice: type a hub URL and key once, and your own computer shows up as a usable runtime on that hub within a few seconds — no separate install, no command to copy anywhere.

If Tailscale isn't installed (or this device isn't joined to a tailnet), that background step just doesn't happen — browsing the hub is completely unaffected, but the app menu swaps **Change Hub…** for **⚠ Runtime not registered**; click it for the reason and the log path (`<app log dir>/runtime-sidecar.log`), with a button back to the hub.

Desktop data lives in the OS app-data directory (macOS: `~/Library/Application Support/dev.kiyora.devdeck/`) — separate databases per mode (`devdeck.db` for "Host locally", `devdeck-runtime.db` for the background runtime spawned by "Connect to a hub"), plus a persisted `runtime-key` so that background runtime keeps the same identity across restarts.

### 13.5 Which one should I use?

| Situation | Use |
|---|---|
| Just you, one computer, simplest setup | `--role both`, or the desktop app's "Host locally" |
| You + a second/third machine for execution power | `--role hub` + one or more `--role runtime` machines |
| You want a native app, and already host a hub elsewhere | Desktop app → "Connect to a hub" |
| You want a native app and nothing else running anywhere | Desktop app → "Host locally" |

## 14. MCP issue-tracker server for agents

`backend/cmd/mcp-server` is a separate binary that exposes DevDeck's issues to a coding agent over MCP (stdio) — handy for having the agent working *inside* a worktree file its own tickets against the same project. It opens the same SQLite `--db` file the main server uses (safe to share, WAL mode).

```bash
make build-mcp   # writes backend/devdeck-mcp-server
```

Point an MCP client at it (e.g. in a worktree's own `.mcp.json`):

```json
{
  "mcpServers": {
    "devdeck-issues": {
      "command": "/path/to/devdeck-mcp-server",
      "args": ["--db", "/path/to/devdeck.db"]
    }
  }
}
```

It exposes four tools: `list_projects`, `create_issue` (assignee is required — the agent should ask if it isn't obvious), `upload_attachment` (attaches a local file and, by default, appends a link/embed to the issue's description), and `mark_issue_done` (moves the issue to **In Review** — a human still does the final close).

## 15. Troubleshooting

- **`make dev` fails immediately, mentions `tailscale`.** You don't have the Tailscale CLI installed. Run `cd frontend && npm run dev` instead.
- **Port already in use.** `make free-ports` kills whatever's listening on `8989`, `5173`, and `9199` (frontend, hub, and the `dev-runtime` port).
- **A worktree opens to a plain shell instead of an agent.** The agent CLI you picked isn't on the backend process's `$PATH` (or its login-shell `$PATH` — DevDeck checks both). Install it, or pick a different agent.
- **Tools page shows a 503 for a conversion.** The underlying CLI (`markitdown`/`pandoc`/`mmdc`) isn't installed — the error message includes the exact install command. See [COMMANDS.md](COMMANDS.md) for the full setup.
- **Lost your 2FA device.** Use one of the one-time backup codes shown at enrollment. If you don't have those either, there's no self-service recovery — you'd need direct database access to clear the account's TOTP secret.
- **A registered machine shows offline.** The hub polls `GET /api/machines/{id}/health` with a 3-second timeout — check the runtime process is actually running and reachable on the URL you registered it with, and that both machines are on the same tailnet if you're not on `127.0.0.1`.
- **New project's machine dropdown is empty.** A brand-new `--role hub` process has no registered Machines yet — see [§13](#13-deployment-modes-hub-both-and-desktop): the fastest fix is restarting with `--role both`, which registers itself automatically.
- **Pasting a connection string fails immediately.** The hub verifies the URL/key against the runtime's `/api/whoami` before registering it — "unreachable" means the URL isn't actually reachable from the hub (check the tailnet), and a rejected key means it doesn't match that runtime's own `--key`.
- **Desktop app shows "⚠ Runtime not registered" instead of "Change Hub…".** This device couldn't self-register as a runtime with the hub you connected to — click the menu item for the reason and log path (`<app log dir>/runtime-sidecar.log`). Most commonly, Tailscale isn't installed or this device isn't joined to a tailnet; browsing the hub itself is unaffected either way.
