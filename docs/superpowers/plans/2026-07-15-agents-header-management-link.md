# Agents Header → Agent Management Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an icon-only "Agent management" button to the Agents page header, next to "New agent", that navigates to the existing (currently unreachable) `/w/$wsId/management` route.

**Architecture:** Single-file UI change. No new components, no new routes, no new state — `AgentManagementModule` and its route already exist and work; this only adds a nav affordance to reach it.

**Tech Stack:** React 19, TanStack Router (`useNavigate`), Tailwind v4, `lucide-react` (`Settings2`, already imported in the target file).

## Global Constraints

- Icons: `lucide-react` only (`.claude/rules/frontend.md`).
- Imports from `src/` use the `@/*` alias, never relative paths (`.claude/rules/frontend.md`).
- `verbatimModuleSyntax` is on — use `import type` for type-only imports (already satisfied; no new type imports needed here).
- Run `npm run typecheck` before considering the task done (`.claude/rules/frontend.md`).
- Design is dark-only, using the existing `loom-*` CSS custom properties — no new colors (`.claude/rules/frontend.md`).
- Route naming/navigation: `/w/$wsId/management` already exists at `frontend/src/routes/w.$wsId.management.tsx` — do not create a new route.

---

### Task 1: Add "Agent management" button to the Agents header

**Files:**
- Modify: `frontend/src/features/agents/WorkspaceHostsView.tsx:113-131` (button group inside the header `<section>`)

**Interfaces:**
- Consumes: `useNavigate` from `@tanstack/react-router` (not yet imported in this file — add `import { useNavigate } from '@tanstack/react-router'` alongside the existing `lucide-react` import block); `wsId` prop already destructured in the component signature (`WorkspaceHostsView({ wsId, projects, selectedProjectId })`, line 24); `Settings2` icon, already imported at line 2.
- Produces: nothing consumed by later tasks — this is the only task in the plan.

The current button group (lines 113–131) is:

```tsx
              <button
                type="button"
                disabled={!hasProjects}
                onClick={() => openSpawn(spawnProjectId, 'root', defaultModel)}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] bg-loom-surface-2 px-3 text-[12px] font-semibold text-loom-muted transition-colors hover:bg-loom-popover hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <House size={13} />
                <span className="hidden sm:inline">Root</span>
              </button>
              <button
                type="button"
                disabled={!hasProjects}
                onClick={() => openSpawn(spawnProjectId, 'branch', defaultModel)}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-loom-border-accent bg-loom-accent-tint px-3 text-[12px] font-semibold text-loom-accent-soft transition-colors hover:bg-loom-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <GitBranch size={13} />
                New agent
              </button>
```

- [ ] **Step 1: Add the `useNavigate` import**

In `frontend/src/features/agents/WorkspaceHostsView.tsx`, change line 1 from:

```tsx
import { useMemo, useState, type ReactNode } from 'react'
```

to:

```tsx
import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
```

- [ ] **Step 2: Wire up `navigate` in the component body**

Immediately after the existing hook calls at the top of `WorkspaceHostsView` (after line 27, `const openNewProject = useLoomStore((s) => s.openNewProject)`), add:

```tsx
  const navigate = useNavigate()
```

- [ ] **Step 3: Add the button, after "New agent"**

Insert this button immediately after the closing `</button>` of the "New agent" button (after line 130, still inside the `<div className="flex items-center gap-2">` wrapper that ends at line 131):

```tsx
              <button
                type="button"
                onClick={() => navigate({ to: '/w/$wsId/management', params: { wsId } })}
                aria-label="Agent management"
                title="Agent management"
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[10px] bg-loom-surface-2 text-loom-muted transition-colors hover:bg-loom-popover hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Settings2 size={14} />
              </button>
```

This button is intentionally never `disabled` (unlike "Root"/"New agent", which require `hasProjects`) since `/w/$wsId/management` is workspace-scoped, not project-scoped.

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no new errors introduced by this change. (Note: this command currently fails on pre-existing unused-variable errors in `WorktreeCard.tsx` and `SpawnDialog.tsx` from before this task — those are out of scope; confirm your diff doesn't add to that list.)

- [ ] **Step 5: Manual verification in the browser**

Run: `cd frontend && npm run dev` (or the project's existing dev workflow — check `COMMANDS.md` if unsure).
- Navigate to a workspace's Agents page (`/w/$wsId`).
- Confirm the new gear-icon button appears immediately to the right of "New agent".
- Click it; confirm the URL changes to `/w/$wsId/management` and the Agent Management page (Skills / MCP management / Settings tabs) renders.
- Click the browser back button; confirm it returns to the Agents page.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/agents/WorkspaceHostsView.tsx
git commit -m "feat(frontend): link Agents header to Agent Management page"
```
