---
paths:
  - "**/*.tsx"
  - "**/*.ts"
---
# Frontend Conventions

## Project-specific rules

- Use `@/*` path alias for all imports from `src/`. Never use relative paths into `src/`.
- `verbatimModuleSyntax` is on — use `import type` for all type-only imports.
- TanStack Router codegens `src/routeTree.gen.ts` — never hand-edit it.
- Route files follow TanStack naming: `w.$wsId.p.$projectId.tsx` (dynamic segments prefixed with `$`, `.index` for index routes).
- Server state lives in `@tanstack/react-query` (queries + mutations in `src/features/data/queries.ts`).
- Transient UI state (dialogs, drafts, sidebar open/close) lives in zustand (`src/store/useDevDeckStore.ts`).
- Domain types are in `src/store/types.ts` — mirror of `backend/internal/domain/models.go`.
- Use `cn()` from `@/lib/utils` for className merging (clsx + tailwind-merge).
- Use `class-variance-authority` for component variants (cva).
- Components live in `src/features/<name>/` — one component per file.
- Every data surface must render explicit loading, error, and empty states.
- Mutations invalidate query cache on success via `queryClient.invalidateQueries()`. Failed mutations show toast + invalidate to resync UI.
- Design is dark-only. Use the CSS custom properties defined in `globals.css` (DevDeck v2 tokens).
- Icons: use `lucide-react` only.
- Toasts: use `sonner` (`toast()` / `toast.success()` / `toast.error()`).
- Dates: use `date-fns` (v4+) with `@date-fns/tz` for timezone-aware formatting.
- Run `npm run typecheck` before committing.
