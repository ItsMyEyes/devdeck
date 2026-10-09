# Agent Workspace 3D

The office is a page inside the DevDeck Tauri desktop app. Open **Agent Workspace 3D** from the workspace sidebar or command palette. The existing Agents page remains available.

## Operating the office

- Select an avatar or a session in the keyboard-accessible roster to open its existing chat. Instructions, questions, approvals and Stop use the existing agent protocol and validation. Opening the office itself starts no agents.
- Select a subagent to inspect its status and open the parent conversation. Subagents have no independent controls.
- Working, waiting, failed, stopped, idle and unverified sessions have separate indicators. Typing follows actual turns. Failed subagents keep their parent in the attention roster.
- Filter by project/session, expand idle history, or switch to List view. Up to 20 recent idle sessions can fill the office; all active/attention sessions remain available. Selecting an older session brings it into the scene.
- Drag to rotate, Shift-drag/right-drag to pan, scroll to zoom; camera buttons focus and reset. Camera preferences are saved locally per workspace.
- Interactive office objects open existing modules. Issues and Todos retain links to their original items. Terminal-only worktrees show known process information and a terminal link.

## Data and compatibility

`GET /api/agent/workspace-overview?workspaceId=…` is authenticated by the existing server middleware and advertised as `agent-workspace-overview`. Go/TypeScript DTOs share the Office fields. The endpoint reads the catalog through `port.Store` and uses the replayable engine projection; it creates no storage table or session.

The frontend queries the hub and relevant runtimes every two seconds while visible. Catalog project ownership and SSH executor ownership choose the source, while source/thread/subagent keys separate identities. Client receipt time determines freshness, avoiding backend clock skew. Failed connections retain stale information and disable chat submission until recovery. Older runtimes expose limited thread information and an upgrade notice; process liveness never implies an AI turn.

SSH connections are global in the current catalog, so their area is explicitly **Shared SSH**. No workspace ownership is invented. Overview metadata excludes full transcripts, tool arguments and credentials. Child token counts appear only when supplied by the provider and are never summed with parent usage or converted to costs.

Three.js/Fiber/Drei load lazily with this page. Reduced motion uses demand rendering; a hidden page stops rendering and polling. WebGL failure preserves the HTML roster and session controls. Narrow layouts use drawers.

## Verification — 2026-10-10

Feature tests: **20 passed** across projection ownership/layout, visible polling, legacy/stale recovery, selected-chat isolation, spawn reuse, local runtime SSH and renderer failure. Backend orchestration and handler packages passed, including replay, immutable snapshots, workspace isolation/deletion/empty/errors, private payload exclusion and completed/failed/stopped subagents. Frontend typecheck/build and backend `go vet ./...` passed.

The actual Tauri development app was built and opened with an isolated SQLite fixture and fake Claude executable. In its desktop window, selecting a session opened the correct chat, Stop interrupted that session, and an instruction received the fake provider's echoed reply. Light/dark themes, camera reset, List view and reduced motion were inspected. Authenticated overview requests succeeded; unauthenticated access returned 401. No paid AI provider was invoked.

Performance device: **Apple M3, 8 GB RAM, macOS 26.6.2**, approximately 1400×900 desktop window, canvas DPR capped at 1.5. With 20 visible avatars and real fake-provider turns, five-second native samples measured **54.2, 31.3, 39.4 and 47.1 FPS**. Supplementary browser samples measured 45.1 and 50.3 FPS. During each 2.5-second hidden-page check there were **zero rendered frames and zero overview requests**. Reduced-motion samples with 19 working avatars measured 0.4–0.6 FPS from data-driven updates. Early instrumentation samples with zero loaded characters are invalid and excluded. Temporary instrumentation was removed from production source.

Local evidence is retained in `output/agent-workspace-3d/desktop-dark.png` and `performance.jsonl` (untracked). Raw test logs were written to `/tmp/devdeck-office-*.log`.

The full frontend run under Node 26 reported 193 passing files and six files with timeout failures. All six were rerun under Node 24 with one worker: **151 tests passed**. The full backend run had two timing failures that passed when rerun, plus two Tailscale detection failures and a terminal PTY exit notification failure in unchanged packages. The three remaining failures were reproduced on the original d9bb849 checkout without this feature. These are recorded separately; the full suites are not claimed green.

Not verified: installer/release packaging, Windows/Linux hardware, a real remote SSH host, every provider's event coverage, or a five-second latency SLA under a real remote network. Desktop testing used the development app and fake providers. This feature has no autonomous task allocation, decorative editor, multi-floor simulation or cost dashboard.

## Checks and fixture

From `frontend`:

```sh
npm run typecheck
npm run build
npx vitest run src/features/agent-workspace --maxWorkers=1
```

From `backend`:

```sh
CGO_ENABLED=0 go test ./internal/agentcore/orchestration ./internal/handler
CGO_ENABLED=0 go vet ./...
```

An optional `TestWriteOfficeSmokeFixture` creates 20 thread fixtures in a fresh directory when `DEVDECK_OFFICE_SMOKE_DIR` is set. It refuses to overwrite an existing database and is skipped during normal tests. Use only with an isolated test server and fake provider; it is not demo data for a production workspace.
