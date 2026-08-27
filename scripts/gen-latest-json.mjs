#!/usr/bin/env node
// Tauri updater manifest generator (spec decision D5 of
// docs/superpowers/specs/2026-08-24-desktop-auto-update-design.md).
//
// The release workflow builds the desktop bundles on three runners and then
// RENAMES them, which breaks Tauri's `<asset>.sig` name pairing. So each
// platform job emits a small fragment carrying the signature CONTENT:
//
//   { "platform": "darwin-aarch64",
//     "signature": "<content of the .sig file>",
//     "assetName": "devdeck-desktop-macos-aarch64.app.tar.gz" }
//
// and the release job merges the three fragments into `latest.json`. A missing
// fragment is a hard error, never a silently absent platform — a manifest that
// omits a platform strands every user on it.
//
// Usage:
//   node scripts/gen-latest-json.mjs fragment \
//     --platform darwin-aarch64 \
//     --bundle-dir frontend/src-tauri/target/release/bundle \
//     --asset-name devdeck-desktop-macos-aarch64.app.tar.gz \
//     --out updater-fragment.json
//
//   node scripts/gen-latest-json.mjs merge \
//     --tag v0.2.1 --notes release-notes.md \
//     --fragments-dir artifacts --out latest.json
//
// Tests: node --test scripts/gen-latest-json.test.mjs

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const REPO_URL = 'https://github.com/ItsMyEyes/devdeck'

/** Filename each platform job writes and uploads as its artifact payload. */
export const FRAGMENT_FILENAME = 'updater-fragment.json'

/**
 * Updater artifact sources, confirmed against the Tauri v2 docs. `bundleDir` is
 * relative to `frontend/src-tauri/target/release/bundle`; `sigSuffix` is how the
 * signature file is named *before* the workflow renames the bundle next to it.
 */
export const PLATFORMS = {
  'darwin-aarch64': { bundleDir: 'macos', sigSuffix: '.app.tar.gz.sig' },
  'linux-x86_64': { bundleDir: 'appimage', sigSuffix: '.AppImage.sig' },
  'windows-x86_64': { bundleDir: 'nsis', sigSuffix: '-setup.exe.sig' },
}

/** Every platform `latest.json` must carry, in the order it is emitted. */
export const REQUIRED_PLATFORMS = Object.keys(PLATFORMS)

/** `v0.2.1` -> `0.2.1`. The bundle's stamped version never carries the `v`. */
export function stripTagPrefix(tag) {
  if (typeof tag !== 'string' || tag.trim() === '') {
    throw new Error('gen-latest-json: a release tag is required')
  }
  return tag.trim().replace(/^v/, '')
}

/** Release-asset download URL. The path keeps the tag verbatim, `v` included. */
export function assetUrl(tag, assetName) {
  if (typeof tag !== 'string' || tag.trim() === '') {
    throw new Error('gen-latest-json: a release tag is required')
  }
  if (typeof assetName !== 'string' || assetName.trim() === '') {
    throw new Error('gen-latest-json: an assetName is required to build a URL')
  }
  return `${REPO_URL}/releases/download/${tag.trim()}/${assetName.trim()}`
}

/**
 * Build one platform's fragment by reading the signature file Tauri emitted
 * next to the bundle. Never returns the path — only the content — because the
 * bundle is renamed afterwards and the names stop matching.
 */
export function buildFragment({ platform, bundleDir, assetName }) {
  const spec = PLATFORMS[platform]
  if (!spec) {
    throw new Error(
      `gen-latest-json: unknown platform ${JSON.stringify(platform)} (expected one of ${REQUIRED_PLATFORMS.join(', ')})`,
    )
  }
  if (typeof assetName !== 'string' || assetName.trim() === '') {
    throw new Error(`gen-latest-json: an assetName is required for ${platform}`)
  }

  const dir = path.join(bundleDir, spec.bundleDir)
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch (err) {
    throw new Error(`gen-latest-json: cannot read bundle directory ${dir}: ${err.message}`)
  }

  const matches = entries.filter((name) => name.endsWith(spec.sigSuffix)).sort()
  if (matches.length === 0) {
    throw new Error(
      `gen-latest-json: no ${spec.sigSuffix} file in ${dir} — the bundle was not signed (are the TAURI_SIGNING_* secrets set?)`,
    )
  }
  if (matches.length > 1) {
    throw new Error(`gen-latest-json: ${matches.length} ${spec.sigSuffix} files in ${dir}, expected exactly one`)
  }

  const signature = fs.readFileSync(path.join(dir, matches[0]), 'utf8').trim()
  if (signature === '') {
    throw new Error(`gen-latest-json: ${path.join(dir, matches[0])} is empty`)
  }

  return { platform, signature, assetName: assetName.trim() }
}

/**
 * Collect every `updater-fragment.json` under an `actions/download-artifact`
 * tree. Unrelated artifacts in the same tree are ignored; a directory that does
 * not exist yields an empty list so the caller reports the missing platforms.
 */
export function readFragments(dir) {
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name === FRAGMENT_FILENAME) {
        let parsed
        try {
          parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
        } catch (err) {
          throw new Error(`gen-latest-json: ${full} is not valid JSON: ${err.message}`)
        }
        found.push(parsed)
      }
    }
  }
  walk(dir)
  return found
}

/** Merge the fragments into the `latest.json` the updater fetches. */
export function buildLatestJson({ tag, notes, fragments, pubDate }) {
  const version = stripTagPrefix(tag)

  const byPlatform = new Map()
  for (const fragment of fragments ?? []) {
    const platform = fragment?.platform
    if (!PLATFORMS[platform]) {
      throw new Error(
        `gen-latest-json: unknown platform ${JSON.stringify(platform)} in fragment (expected one of ${REQUIRED_PLATFORMS.join(', ')})`,
      )
    }
    if (byPlatform.has(platform)) {
      throw new Error(`gen-latest-json: duplicate fragment for platform ${platform}`)
    }
    if (typeof fragment.signature !== 'string' || fragment.signature.trim() === '') {
      throw new Error(`gen-latest-json: fragment for ${platform} has an empty signature`)
    }
    if (typeof fragment.assetName !== 'string' || fragment.assetName.trim() === '') {
      throw new Error(`gen-latest-json: fragment for ${platform} has no assetName`)
    }
    byPlatform.set(platform, fragment)
  }

  // A manifest that omits a platform strands every user on it, so this is fatal.
  const missing = REQUIRED_PLATFORMS.filter((p) => !byPlatform.has(p))
  if (missing.length > 0) {
    throw new Error(`gen-latest-json: missing updater fragment(s) for ${missing.join(', ')}`)
  }

  const platforms = {}
  for (const platform of REQUIRED_PLATFORMS) {
    const fragment = byPlatform.get(platform)
    platforms[platform] = {
      signature: fragment.signature.trim(),
      url: assetUrl(tag, fragment.assetName),
    }
  }

  return {
    version,
    notes: notes ?? '',
    pub_date: pubDate ?? new Date().toISOString(),
    platforms,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      throw new Error(`gen-latest-json: unexpected argument ${arg}`)
    }
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`gen-latest-json: ${arg} needs a value`)
    }
    out[key] = value
    i += 1
  }
  return out
}

function required(args, name) {
  const value = args[name]
  if (value === undefined) {
    throw new Error(`gen-latest-json: --${name} is required`)
  }
  return value
}

function cmdFragment(argv) {
  const args = parseArgs(argv)
  const out = args.out ?? FRAGMENT_FILENAME
  const fragment = buildFragment({
    platform: required(args, 'platform'),
    bundleDir: required(args, 'bundle-dir'),
    assetName: required(args, 'asset-name'),
  })
  fs.writeFileSync(out, `${JSON.stringify(fragment, null, 2)}\n`)
  // Deliberately does not print the fragment: signatures stay out of the log.
  console.log(`wrote ${out} for ${fragment.platform} (${fragment.assetName})`)
}

function cmdMerge(argv) {
  const args = parseArgs(argv)
  const tag = required(args, 'tag')
  const fragmentsDir = args['fragments-dir'] ?? 'artifacts'
  const out = args.out ?? 'latest.json'

  let notes = ''
  if (args.notes !== undefined) {
    notes = fs.readFileSync(args.notes, 'utf8')
  }

  const manifest = buildLatestJson({ tag, notes, fragments: readFragments(fragmentsDir) })
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`wrote ${out} for ${manifest.version}: ${REQUIRED_PLATFORMS.join(', ')}`)
}

function main(argv) {
  const [command, ...rest] = argv
  switch (command) {
    case 'fragment':
      cmdFragment(rest)
      break
    case 'merge':
      cmdMerge(rest)
      break
    default:
      throw new Error(`gen-latest-json: unknown command ${JSON.stringify(command ?? '')} (expected "fragment" or "merge")`)
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
