# Agent Workspace 3D

The office is a page inside the DevDeck Tauri desktop app. Open **Agent Workspace 3D** from the workspace sidebar or command palette. The existing Agents page remains available.

## Operating the office

- Select an avatar or a session in the keyboard-accessible roster to open its existing chat. Instructions, questions, approvals and Stop use the existing agent protocol and validation. Opening the office itself starts no agents.
- Select a subagent to inspect its status and open the parent conversation. Subagents have no independent controls.
- Working, waiting, failed, stopped, idle and unverified sessions have separate indicators. Typing follows actual turns. Failed subagents keep their parent in the attention roster.
- Idle avatars appear automatically; expand idle history to browse the roster. Filter by project/session or switch to List view. Each scene has at most 20 session slots, prioritizing attention and active turns. All sessions remain available in the roster; selecting an older session brings it into the scene.
- In Move mode (the default), drag to slide the camera along the floor. Switch to Rotate to orbit. Use arrow buttons to move, scroll/pinch or +/− to zoom, and the reset button to return to the office view. Camera preferences are saved locally per workspace and floor view.
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

Not verified in the initial release: installer/release packaging, Windows/Linux hardware, a real remote SSH host, every provider's event coverage, or a five-second latency SLA under a real remote network. Desktop testing used the development app and fake providers. This feature has no autonomous task allocation, decorative editor or cost dashboard. The natural-animation update below adds visual idle routines only.

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

## Camera controls update — 2026-10-10

Direct dragging now pans by default, with visible Move/Rotate modes and four directional buttons. Panning follows the current view and preserves height, angle and zoom. Button movements also persist workspace camera preferences. One-finger touch follows the selected mode; two-finger pinch zooms and pans.

Three camera regression tests failed against the previous action behavior, then passed with the movement change. All 23 feature tests and frontend typecheck passed. Native desktop testing against the existing production backend confirmed direct drag, directional movement and Rotate mode, leaving Move selected. This test sent no agent instructions and restarted no production sessions. Physical touch input was not tested.

The camera update's frontend build passed. The full frontend rerun passed 199 files / 2,226 tests, with one existing `src/features/editor/monacoLspClient.guard.test.ts` failure: importing Monaco exceeded its five-second timeout. The camera tests were green; editor code was unchanged.
The Monaco guard passed with a 15-second test timeout (6.32-second import/test). Its original five-second limit remains unchanged.

## Developer and DevOps floors — 2026-10-10

The initial **Gedung** view shows an open building with two floors and stairs. **1 · Developer** contains repo/worktree sessions; **2 · DevOps** contains any session with a `connectionId`. Provider/model does not determine the division. Subagents use their parent's division and chat. Choosing a floor hides the other interior. The last view is saved under `devdeck.office-view.<workspace>`; camera poses use `devdeck.office-camera.<workspace>.<view>`. Reset affects only the current view, including when invoked in List mode.

Roster groups retain all active/attention sessions and expandable idle history. The scene admits at most 20 sessions, alternating divisions within each status priority in Gedung. Each interior has its own 20-slot limit. Selection opens the correct floor and existing chat; manual floor changes preserve that chat and its division label. Project and Shared SSH filters select the corresponding floor, and the activity feed follows the visible floor. Arrow keys/Home/End operate the floor selector.

Both floors share a footprint, with independently retained project/connection desk layouts. Developer adds collaboration tables, glass, whiteboard, Issues/Todos links, lounge, pantry and Memory. DevOps adds server racks, a coordination table, equipment storage and runbooks. Runtime boards show actual source availability only; server/operations objects open existing Runtimes/SSH modules. Empty floors have furniture without sample avatars. Layout, themes, camera controls, reduced motion, lazy loading and HTML fallback remain available. No backend endpoints, database migrations or agent protocol changes were made for this update.

Native smoke testing covered Gedung, both interiors, drag/pan/rotate/zoom/reset, session selection and retained chat, light/dark themes, keyboard floor navigation, List reset and WebGL loss/recovery. The desktop preview also opened the existing local production workspace and its real Shared SSH catalog through the installed backend. Its older API shows **Unverified**/limited status rather than inventing turns. Production testing sent no agent instructions or interrupts and did not restart or upgrade that backend.

Final verification under Node 24: **43 feature tests passed**, frontend typecheck/build passed, and the complete frontend suite passed **201 files / 2,247 tests**, using two workers and a 15-second test timeout. The unchanged Monaco guard previously exceeded the default five-second timeout; no repository timeout setting was changed. New regressions cover division identity/subagents, balanced admission and the hard 20-slot cap, filtered-session desks, history collapse, feed/view selection, workspace preferences, keyboard focus, per-view camera restore/reset/remount and persistence after session focus. A fresh independent review's scene-cap and navigation/reset findings were fixed and verified before completion.

Performance fixture: 20 active avatars in Gedung (10 per division), then 20 on Developer; isolated test backend, no paid provider. Device: **Apple M3, 8 GB RAM, macOS 26.6.2**, Tauri 1400×845 and supplementary browser 1280×720, DPR capped at 1.5. Default-camera native samples measured **57.95–58.8 FPS** in Gedung and **57.59–59.2 FPS** on Developer. Browser foreground samples measured 37.25 FPS in Gedung and 40.39–41.59 FPS on Developer. Native and browser hidden checks both recorded **zero render frames and zero overview requests**.

The 30 FPS target is met at the measured default camera on this device, but not consistently across all samples: native samples during closer zoom, interaction and concurrent browser/test workload fell to **21.59–28.99 FPS**. A browser 10.99 FPS sample overlapped the intentional hidden check and is not a foreground benchmark. Raw evidence is retained in untracked `output/agent-workspace-3d/two-floors-performance.jsonl`; temporary instrumentation was removed. Measurements preceded the final compact desk arrangement, which was subsequently smoke-tested visually in the native production preview. Performance on other hardware and physical touch gestures remains unverified; no production installer upgrade is included.

## Character names, session history and Project → VM — 2026-10-11

Each thread now stores a randomly generated `characterName`, independently of its conversation title, provider and model. Startup backfills only missing names; existing names remain unchanged. Subagent display names derive from parent identity and child ID. Avatar labels, roster, session search and selected details use these names.

**Akhiri sesi** is separate from composer Stop. It blocks new turns and responses while ending, cancels pending requests, interrupts any active turn and stops the existing provider session. An archive is confirmed only after that succeeds. Failure keeps the session in the office and preserves its running state and Stop control. Claude/Pi shutdown waits for process-reader completion; OpenCode waits for its SSE subscription; Codex retains bindings until unsubscribe acknowledgement so a failed request can be retried. Queued provider events cannot cross the retained archive boundary after resume. This boundary uses locally stamped provider timestamps, is replayed from the archive event and prevents obsolete prompts/plans/subagent events from reviving work.

Confirmed archives leave the office roster, avatars and counts. **Riwayat sesi** searches character/title and filters Developer/DevOps, project, parent category and VM. Opening an archive reads the retained transcript. **Lanjutkan sesi** restores the same character as idle; it never provisions a provider or sends a turn. Agents and Shared SSH session lists also label archives and keep their composer read-only until explicit resume. Duplicate lifecycle commands have durable receipts. Only the backend can confirm archival.

SSH hosts now have a free-text **Parent project** with suggestions from saved categories. This is separate from `Group`; clearing it places the host under **Tanpa project**. DevOps desks, roster and filters use parent category → saved connection ID → sessions. Equal IP addresses do not merge hosts. Status updates preserve desk positions; intentionally changing parent category moves that host's group. SSH chat history is read from the same executor backend as its conversation.

Persistence uses additive columns `agent_thread.character_name`, `agent_thread.archived_at` and `ssh_connection.parent_project`; no messages are removed. Parent metadata is included in catalog replication. Capabilities `agent-session-lifecycle` and `ssh-parent-project` advertise support. Old backends remain readable but disable unsupported persistent controls with an update notice, without local-only substitutes.

Verification: frontend **204 files / 2,263 tests passed**, plus typecheck and production build. The full frontend run used Node 24, one worker and a 30-second test timeout to accommodate the unchanged Monaco import test. Backend orchestration, all four provider packages, store and handler checks passed; `go vet ./...` passed. Regression tests were observed failing before fixes for shutdown acknowledgement, late events after resume, archive failure keeping Stop, and Codex retry/child routing. Full backend testing still reports the existing two Tailscale detection failures and the previously reproduced terminal PTY exit-notification failure. A Tailscale serve timing failure passed when rerun separately, including on the original checkout. Unchanged infrastructure tests are not claimed green.

Native Tauri smoke used an isolated fresh SQLite fixture: 20 Developer sessions and 10 Shared SSH sessions across three VM IDs (two in AIGN, one without a parent), with a fake Claude executable. Active and idle archives, read-only history/search, same-name resume, duplicate commands, another socket's rejected turn, authentication, separate Group/parent roundtrip and backend restart were checked without paid AI calls. Restart preserved all 30 names, two archives and host categories, and started no provider work. After the provider shutdown fixes, active archive/resume was repeated successfully: shutdown acknowledged, new turn rejected while archived, then same character idle with no new provider session. The actual desktop window was inspected after restart; production backend and installer were not upgraded, and production agent sessions were not instructed or interrupted.

Performance device: Apple M3, 8 GB RAM, macOS 26.6.2; Tauri window 1400×845, DPR capped at 1.5. Eight controlled default-camera samples with **20 visible characters in Gedung** measured **46.39–59.20 FPS**; twelve Developer samples with **20 characters** measured **56.79–60.14 FPS**. These exclude overnight/uncontrolled samples. The bounded native hide check made zero new overview requests after the in-flight request settled; existing hidden-frame samples measured zero frames. Idle demand rendering is not a foreground animation FPS benchmark. Temporary probes were removed before the final build. Local evidence is untracked in `output/agent-workspace-3d/session-lifecycle-desktop.png` and `session-lifecycle-performance.jsonl`.

Scope limits remain: real remote-provider lifecycle, a second physical device, other hardware/OS and release-installer upgrade are unverified. Restart reconciliation follows the existing backend contract that provider instances are rebuilt empty; it does not establish new acknowledgement from an externally surviving remote process. The earlier closer-zoom performance caveat still applies. Deferred review polish: formatting in several added TS blocks and an outdated introductory SSH history comment; runtime routing uses the executor correctly.


## Natural character animation — 2026-10-11

Characters now have independent shoulders, elbows, hands, hips, knees and head joints. Verified working turns use seated laptop typing with alternating hands, trackpad pauses and reading. Running subagents have companion workstations; failed children retain an error gesture. Questions, approvals, ready plans and errors interrupt relaxation. Stale or limited sources remain neutral and marked unverified. These visuals never delay or start actual agent execution.

Both interiors have a sofa, beanbag, coffee/tea counters, drinking chair, guitar corner, reading chair, stretching mat and plant. Verified idle sessions wait a seeded 8–15 seconds, reserve an available destination, approach, pick up/position themselves, perform for 20–60 seconds, put things down and return. Consecutive activities differ; a full lounge falls back to desk reading/stretching. Furniture-derived routes use exact segment clearance, passing waypoints and retreat from narrow aisles. Removal, archival, filters and group changes release temporary reservations. Companion furniture appearing during transit triggers checked escape/replanning. Moving labels and click targets follow actors; camera selection uses the actor's current position, including children.

The controller and pose calculation are frontend-only and independently tested. Frame updates use Three.js object references and shared geometry/materials. Hidden scenes stop rendering and routine time; resuming reconciles current status without animation catchup. Reduced motion keeps static desk poses and demand rendering. The HTML roster and WebGL fallback remain available. Development diagnostics record transitions and reservations, without conversation text or per-frame logs.

Validation: **87 feature tests passed**, including all nine interruptions, exclusive reservations, unavailable destinations, source truth, filtering/removal, selection, hidden/reduced rendering and crowded twenty-actor return on both floors. Read-only code review additionally simulated 5, 10 and 20 actors per floor through 120 seconds idle and 120 seconds after work interruption; every actor returned home. Frontend typecheck and production build passed. The broad frontend run passed 2,280 tests with three timeout failures in unchanged chat/editor suites; all three passed on focused reruns (Monaco required a 20-second timeout).

Native Tauri preview used a copied SQLite fixture and local overview proxy, with no production database writes or paid provider execution. Both themes, both interiors, close zoom, sofa/beanbag placement, laptop hands, roaming selection and subagent parent routing were inspected. A bounded native hide check emitted no frames or overview requests after settling. Reduced-motion native samples measured roughly 0.4–0.8 frames/second from data changes, with static actors.

On the existing Apple M3/8 GB/macOS test device, controlled five-second foreground samples measured **55.44–60.45 FPS** for mixed 20 parents + 20 children (10 samples), **56.82–60.23 FPS** for working 20 parents + 20 children (11 samples), and **56.43–60.21 FPS** for idle 20 parents (16 samples). Measurements include close zoom; these are device-specific development-preview results. Temporary instrumentation lives outside tracked source. Screenshots and controlled samples are retained untracked in `output/agent-workspace-3d/natural-*-desktop.png` and `natural-animation-performance.json`.

The installed production application was not replaced. Windows/Linux hardware, screen-reader interaction and exhaustive clipping across every possible layout remain unverified.
