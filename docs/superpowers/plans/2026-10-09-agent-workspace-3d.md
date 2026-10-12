# Agent Workspace 3D

Approved in chat, 2026-10-09. Branch codex/agent-workspace-3d, base d9bb849.

A workspace-scoped operational isometric office: real agent sessions and subagents,
activity feed, attention queue, existing chat controls and links to existing modules.
Target 20 visible avatars inside the DevDeck Tauri desktop app, light/dark, reduced motion and HTML fallback. Browser checks are supplementary renderer tests.
No autonomous orchestration, decoration editor, simulation or new storage schema.

## Tasks
1. Derive compact, replayable overview from engine events; authenticated workspace overview endpoint and capability. Test replay, immutable snapshots, status, isolation and SSH.
2. Query hub/runtimes every 2s while visible; deduplicate owners, handle stale/legacy sources, expose HTML roster and reuse chat panels. Test transformations and lifecycle.
3. Lazy Three.js/Fiber9/Drei office, deterministic areas, camera persistence, real-state animation, responsive panels and navigation integrations.
4. Run backend/frontend suites, typecheck/build/vet, isolated browser smoke with fake providers and 20-agent performance check; run desktop smoke, record limits. Review whole change.

## Decisions
- Native app worktree tool cannot locate nested repository (chat cwd is Project); use sibling Git worktree as fallback, preserving primary checkout.
- SSH connections have no workspace ownership in current schema: explicitly label them Shared SSH rather than inventing a workspace association. Respect executor ownership and existing access controls.
- Overview snapshots omit transcript, tool arguments and credentials. Selected session alone mounts existing full chat.
- Keep existing provider protocols and stop/approval behavior. No independent subagent actions.
