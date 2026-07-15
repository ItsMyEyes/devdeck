# Agents header: link to Agent Management

## Problem

`AgentManagementModule` (`/w/$wsId/management` — Skills / MCP management / Settings
tabs) is fully built but unreachable: no nav element anywhere in the app links to
it. The user wants a way in from the Agents page header, next to the "New agent"
button.

## Design

Add an icon-only settings button to the Agents header
(`frontend/src/features/agents/WorkspaceHostsView.tsx`), placed after the existing
"New agent" button (same button group, far right of the header row).

- Icon: `Settings2` (already imported in this file; same icon used for the
  existing per-project "Edit project" affordance).
- Styling: neutral variant matching the "Root" button (`bg-loom-surface-2`,
  `text-loom-muted`, `hover:bg-loom-popover hover:text-loom-fg`) — icon-only,
  fixed square size (`h-9 w-9`), not the accent-tinted CTA style used for "New
  agent".
- `aria-label="Agent management"` for accessibility (no visible text label).
- On click: `useNavigate()` → `navigate({ to: '/w/$wsId/management', params: { wsId } })`,
  the same call pattern already used in `AgentsBreadcrumb.tsx`.
- Always enabled (unlike "Root"/"New agent", not gated on `hasProjects` — the
  management page is workspace-scoped, not project-scoped).

## Out of scope

- No changes to `AgentManagementModule.tsx` or its tabs — the page itself is
  already complete.
- No changes to `Header.tsx`'s view-suppression logic for the `management` view.
