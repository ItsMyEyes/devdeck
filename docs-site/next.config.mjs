import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// NEXT_PUBLIC_ prefix required — Next.js only inlines prefixed env vars into
// client-side bundles, and lib/shared.ts's `basePath` export (read by
// components/search-dialog.tsx, a client component) needs the same value.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  output: 'export',
  basePath,
  images: {
    unoptimized: true,
  },
};

export default withMDX(config);
