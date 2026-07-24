# Fumadocs documentation site — design

**Date:** 2026-07-24
**Status:** Approved

## Problem

DevDeck's user-facing documentation currently lives only as long-form Markdown
(`TUTORIAL.md`, `README.md`, `COMMANDS.md`, `ARCHITECTURE.md`) browsed
directly on GitHub. There's no structured, navigable, searchable docs site.
This adds one, built with [Fumadocs](https://www.fumadocs.dev/), containing a
fresh step-by-step onboarding guide (not a migration of the existing
Markdown).

## Architecture

A new top-level `docs-site/` folder, sibling to `frontend/` and `backend/`,
scaffolded via the Fumadocs CLI:

```bash
npm create fumadocs-app
# template: Next.js + fumadocs-mdx
# package manager: npm
```

This generates the standard Fumadocs project layout:

```
docs-site/
├── app/
│   ├── layout.tsx            # root layout
│   ├── docs/[[...slug]]/     # DocsLayout + MDX page renderer
│   └── (home)/               # landing page
├── content/docs/              # MDX source files
├── lib/source.ts              # content source loader
├── source.config.ts           # fumadocs-mdx config
├── next.config.mjs
└── package.json
```

It is fully standalone:

- Own `package.json`, own `node_modules`, own `npm run dev` (default port
  `3000` — no collision with the frontend's `5173` or backend's `8989`).
- **Not** wired into the root `Makefile`, `make dev`, or CI. Docs aren't part
  of the product runtime or build/release pipeline.
- `TUTORIAL.md` and the other root Markdown docs are left untouched — the
  docs site is a separate, parallel presentation, not a replacement.

## Branding

`docs/logo/devdeck.png` (already in the repo) is used as the docs site's
logo/favicon source, so it visually matches the app rather than shipping
Fumadocs' default branding.

## Content structure

Fresh MDX pages under `content/docs/`, ordered via `meta.json`. Content is
written natively for Fumadocs (not copy-pasted from `TUTORIAL.md`), but the
page order and factual coverage are verified against `TUTORIAL.md`'s section
order (§1–§15) so nothing about the real app flow is misrepresented.
Deferred/unshipped modules (Todos, News, Invoices — see `TUTORIAL.md` §9–10)
are excluded.

Pages, in sidebar order:

1. **index.mdx** — what DevDeck is (short, links back to the README pitch)
2. **installation.mdx** — see "Installation content" below
3. **first-account.mdx** — register; the 2FA setup path vs. the `--2fa=false`
   dev/desktop path
4. **workspaces-and-projects.mdx** — create a workspace, add a project
   (local folder or GitHub URL), pick which registered Machine runs it
5. **first-worktree.mdx** — spawn an agent worktree: branch name, base
   branch, task description, agent/model selection
6. **working-in-a-worktree.mdx** — the tiling pane workspace, terminal
   panes, root-mode terminal
7. **issues.mdx** — the Issues tab
8. **agent-management.mdx** — detected agent CLIs on `$PATH`, install/config
9. **tools.mdx** — the Tools page (markitdown/pandoc/mermaid-cli)
10. **deployment-modes.mdx** — hub / runtime / both / desktop roles,
    Tailscale-based hub exposure
11. **troubleshooting.mdx** — common gotchas (e.g. restart-required-after-
    Tailscale-setup, empty machine dropdown on a fresh hub)

### Installation content (installation.mdx)

Per the actual release pipeline (`.github/workflows/release.yml`), each
tagged release (`v*.*.*`) publishes two distinct kinds of asset — the page
must present both, not a single installer:

- **Desktop app** (Tauri, bundles the Go server as a sidecar binary) —
  `devdeck-desktop-macos-aarch64.dmg`,
  `devdeck-desktop-linux-amd64.{deb,rpm,AppImage}`,
  `devdeck-desktop-windows-amd64.msi` / `-setup.exe`
- **Runtime/hub server binaries** (headless, no UI) —
  `devdeck-runtime-*`, run with `--role hub`, `--role runtime`, or
  `--role both`

The page sends readers to `https://github.com/ItsMyEyes/devdeck/releases`,
has them pick the desktop-app asset for their OS (most users) or a runtime
binary (headless/server deployments), download, and run. There is no
`git clone` / `make install` / build-from-source content on this page — that
path is intentionally excluded, not merely de-emphasized.

## Out of scope (this pass)

- No deployment/hosting setup for the docs site itself, no CI wiring.
- No search backend beyond Fumadocs' built-in local search.
- No auth-gating of the docs site.
- No migration of `TUTORIAL.md`/`README.md`/`COMMANDS.md`/`ARCHITECTURE.md`
  content — those stay as-is.
- No build-from-source instructions on the installation page.

## Testing

- `npm run build` inside `docs-site/` succeeds.
- Manual check: `npm run dev` inside `docs-site/` serves the site locally,
  all 11 sidebar pages render and link correctly, logo/favicon show the
  DevDeck mark.
