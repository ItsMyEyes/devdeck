export const appName = 'DevDeck';
// Must match next.config.mjs's basePath exactly. NEXT_PUBLIC_ prefix is
// required so this value is inlined into client bundles too (used by
// components/search-dialog.tsx, a 'use client' component) — next/image's
// automatic basePath prefixing also doesn't apply when images.unoptimized
// is set, so the nav logo needs this prepended manually as well.
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export const gitConfig = {
  user: 'ItsMyEyes',
  repo: 'devdeck',
  branch: 'main',
};
