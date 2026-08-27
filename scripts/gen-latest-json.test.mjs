// Tests for scripts/gen-latest-json.mjs — the Tauri updater manifest generator.
//
// Run with node's built-in runner (no vitest here — this is CI tooling, not
// frontend code):
//
//   node --test scripts/gen-latest-json.test.mjs

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  PLATFORMS,
  REQUIRED_PLATFORMS,
  FRAGMENT_FILENAME,
  stripTagPrefix,
  assetUrl,
  buildFragment,
  readFragments,
  buildLatestJson,
} from './gen-latest-json.mjs'

const SCRIPT = fileURLToPath(new URL('./gen-latest-json.mjs', import.meta.url))

function tmpdir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  return dir
}

/** Lay out `artifacts/<artifact-name>/updater-fragment.json` the way
 *  actions/download-artifact does. */
function writeFragmentFile(root, artifactName, fragment) {
  const dir = path.join(root, artifactName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, FRAGMENT_FILENAME), JSON.stringify(fragment, null, 2))
}

const macFragment = {
  platform: 'darwin-aarch64',
  signature: 'SIG-MAC',
  assetName: 'devdeck-desktop-macos-aarch64.app.tar.gz',
}
const linuxFragment = {
  platform: 'linux-x86_64',
  signature: 'SIG-LINUX',
  assetName: 'devdeck-desktop-linux-amd64.AppImage',
}
const winFragment = {
  platform: 'windows-x86_64',
  signature: 'SIG-WIN',
  assetName: 'devdeck-desktop-windows-amd64-setup.exe',
}
const allFragments = [macFragment, linuxFragment, winFragment]

describe('stripTagPrefix', () => {
  test("strips a leading 'v' from the tag", () => {
    assert.equal(stripTagPrefix('v0.2.1'), '0.2.1')
  })

  test('leaves a tag that has no prefix alone', () => {
    assert.equal(stripTagPrefix('0.2.1'), '0.2.1')
  })

  test("only strips the leading 'v', not one inside the version", () => {
    assert.equal(stripTagPrefix('v1.0.0-rc.1'), '1.0.0-rc.1')
  })

  test('rejects an empty tag', () => {
    assert.throws(() => stripTagPrefix(''), /tag/i)
  })
})

describe('assetUrl', () => {
  test('builds a release download URL from the tag and the asset name', () => {
    assert.equal(
      assetUrl('v0.2.1', 'devdeck-desktop-macos-aarch64.app.tar.gz'),
      'https://github.com/ItsMyEyes/devdeck/releases/download/v0.2.1/devdeck-desktop-macos-aarch64.app.tar.gz',
    )
  })

  test('uses the tag verbatim in the path, not the stripped version', () => {
    // The release is tagged `v0.2.1`; the download path must keep the `v`
    // even though `version` in the manifest drops it.
    const url = assetUrl('v0.2.1', 'x.AppImage')
    assert.match(url, /\/download\/v0\.2\.1\//)
  })
})

describe('buildLatestJson', () => {
  test('produces the documented manifest shape', () => {
    const manifest = buildLatestJson({
      tag: 'v0.2.1',
      notes: 'Fixed the thing.\n',
      fragments: allFragments,
      pubDate: '2026-08-24T10:00:00.000Z',
    })

    assert.deepEqual(manifest, {
      version: '0.2.1',
      notes: 'Fixed the thing.\n',
      pub_date: '2026-08-24T10:00:00.000Z',
      platforms: {
        'darwin-aarch64': {
          signature: 'SIG-MAC',
          url: 'https://github.com/ItsMyEyes/devdeck/releases/download/v0.2.1/devdeck-desktop-macos-aarch64.app.tar.gz',
        },
        'linux-x86_64': {
          signature: 'SIG-LINUX',
          url: 'https://github.com/ItsMyEyes/devdeck/releases/download/v0.2.1/devdeck-desktop-linux-amd64.AppImage',
        },
        'windows-x86_64': {
          signature: 'SIG-WIN',
          url: 'https://github.com/ItsMyEyes/devdeck/releases/download/v0.2.1/devdeck-desktop-windows-amd64-setup.exe',
        },
      },
    })
  })

  test('defaults pub_date to an RFC3339 timestamp', () => {
    const manifest = buildLatestJson({ tag: 'v1.2.3', notes: 'n', fragments: allFragments })
    assert.match(manifest.pub_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  })

  test('emits platform keys in a stable order', () => {
    const manifest = buildLatestJson({
      tag: 'v1.2.3',
      notes: 'n',
      fragments: [winFragment, macFragment, linuxFragment],
    })
    assert.deepEqual(Object.keys(manifest.platforms), REQUIRED_PLATFORMS)
  })

  for (const missing of ['darwin-aarch64', 'linux-x86_64', 'windows-x86_64']) {
    test(`is a hard error when the ${missing} fragment is missing`, () => {
      const fragments = allFragments.filter((f) => f.platform !== missing)
      assert.throws(
        () => buildLatestJson({ tag: 'v0.2.1', notes: 'n', fragments }),
        new RegExp(`missing updater fragment.*${missing}`, 'i'),
      )
    })
  }

  test('is a hard error when every fragment is missing', () => {
    assert.throws(
      () => buildLatestJson({ tag: 'v0.2.1', notes: 'n', fragments: [] }),
      /missing updater fragment/i,
    )
  })

  test('rejects a fragment with an unknown platform key', () => {
    assert.throws(
      () =>
        buildLatestJson({
          tag: 'v0.2.1',
          notes: 'n',
          fragments: [...allFragments, { platform: 'darwin-x86_64', signature: 's', assetName: 'a' }],
        }),
      /unknown platform/i,
    )
  })

  test('rejects a fragment with an empty signature', () => {
    const fragments = [{ ...macFragment, signature: '' }, linuxFragment, winFragment]
    assert.throws(() => buildLatestJson({ tag: 'v0.2.1', notes: 'n', fragments }), /signature/i)
  })

  test('rejects a fragment with no assetName', () => {
    const fragments = [{ platform: 'darwin-aarch64', signature: 's' }, linuxFragment, winFragment]
    assert.throws(() => buildLatestJson({ tag: 'v0.2.1', notes: 'n', fragments }), /assetName/i)
  })

  test('rejects two fragments claiming the same platform', () => {
    assert.throws(
      () => buildLatestJson({ tag: 'v0.2.1', notes: 'n', fragments: [...allFragments, macFragment] }),
      /duplicate/i,
    )
  })
})

describe('buildFragment', () => {
  test('reads the signature content out of the platform bundle directory', () => {
    const bundle = tmpdir('bundle')
    const dir = path.join(bundle, PLATFORMS['darwin-aarch64'].bundleDir)
    fs.mkdirSync(dir, { recursive: true })
    // Tauri names the sig after the ORIGINAL bundle name; the workflow renames
    // the bundle afterwards, so the names no longer pair up. Hence: content.
    fs.writeFileSync(path.join(dir, 'DevDeck.app.tar.gz.sig'), 'dW50cnVzdGVk\n')

    assert.deepEqual(
      buildFragment({
        platform: 'darwin-aarch64',
        bundleDir: bundle,
        assetName: 'devdeck-desktop-macos-aarch64.app.tar.gz',
      }),
      {
        platform: 'darwin-aarch64',
        signature: 'dW50cnVzdGVk',
        assetName: 'devdeck-desktop-macos-aarch64.app.tar.gz',
      },
    )
  })

  test('finds the AppImage signature for linux', () => {
    const bundle = tmpdir('bundle')
    const dir = path.join(bundle, PLATFORMS['linux-x86_64'].bundleDir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'DevDeck_0.2.1_amd64.AppImage.sig'), 'LINUXSIG')

    const fragment = buildFragment({
      platform: 'linux-x86_64',
      bundleDir: bundle,
      assetName: 'devdeck-desktop-linux-amd64.AppImage',
    })
    assert.equal(fragment.signature, 'LINUXSIG')
  })

  test('finds the nsis setup signature for windows', () => {
    const bundle = tmpdir('bundle')
    const dir = path.join(bundle, PLATFORMS['windows-x86_64'].bundleDir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'DevDeck_0.2.1_x64-setup.exe.sig'), 'WINSIG')

    const fragment = buildFragment({
      platform: 'windows-x86_64',
      bundleDir: bundle,
      assetName: 'devdeck-desktop-windows-amd64-setup.exe',
    })
    assert.equal(fragment.signature, 'WINSIG')
  })

  test('errors when no signature file was produced', () => {
    const bundle = tmpdir('bundle')
    fs.mkdirSync(path.join(bundle, PLATFORMS['darwin-aarch64'].bundleDir), { recursive: true })
    assert.throws(
      () => buildFragment({ platform: 'darwin-aarch64', bundleDir: bundle, assetName: 'x' }),
      /no .*\.sig/i,
    )
  })
})

describe('readFragments', () => {
  test('collects fragments from a downloaded artifacts tree', () => {
    const root = tmpdir('artifacts')
    writeFragmentFile(root, 'updater-fragment-darwin-aarch64', macFragment)
    writeFragmentFile(root, 'updater-fragment-linux-x86_64', linuxFragment)
    writeFragmentFile(root, 'updater-fragment-windows-x86_64', winFragment)
    // Unrelated artifacts in the same tree must be ignored.
    fs.mkdirSync(path.join(root, 'backend-binaries'), { recursive: true })
    fs.writeFileSync(path.join(root, 'backend-binaries', 'checksums.txt'), 'deadbeef  x')
    fs.writeFileSync(path.join(root, 'backend-binaries', 'something.json'), '{"not":"a fragment"}')

    const fragments = readFragments(root)
    assert.equal(fragments.length, 3)
    assert.deepEqual(
      fragments.map((f) => f.platform).sort(),
      ['darwin-aarch64', 'linux-x86_64', 'windows-x86_64'],
    )
  })

  test('returns an empty list for a directory that does not exist', () => {
    assert.deepEqual(readFragments(path.join(tmpdir('artifacts'), 'nope')), [])
  })
})

describe('cli', () => {
  function run(args, cwd) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
  }

  test('merge writes latest.json from a complete fragment tree', () => {
    const root = tmpdir('cli')
    const artifacts = path.join(root, 'artifacts')
    writeFragmentFile(artifacts, 'updater-fragment-darwin-aarch64', macFragment)
    writeFragmentFile(artifacts, 'updater-fragment-linux-x86_64', linuxFragment)
    writeFragmentFile(artifacts, 'updater-fragment-windows-x86_64', winFragment)
    fs.writeFileSync(path.join(root, 'release-notes.md'), '- fixed a thing\n')

    const res = run(
      [
        'merge',
        '--tag',
        'v0.2.1',
        '--notes',
        'release-notes.md',
        '--fragments-dir',
        'artifacts',
        '--out',
        'latest.json',
      ],
      root,
    )
    assert.equal(res.status, 0, res.stderr)

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'))
    assert.equal(manifest.version, '0.2.1')
    assert.equal(manifest.notes, '- fixed a thing\n')
    assert.equal(
      manifest.platforms['windows-x86_64'].url,
      'https://github.com/ItsMyEyes/devdeck/releases/download/v0.2.1/devdeck-desktop-windows-amd64-setup.exe',
    )
    assert.equal(manifest.platforms['darwin-aarch64'].signature, 'SIG-MAC')
  })

  test('merge exits non-zero when a platform fragment is missing', () => {
    const root = tmpdir('cli')
    const artifacts = path.join(root, 'artifacts')
    writeFragmentFile(artifacts, 'updater-fragment-darwin-aarch64', macFragment)
    writeFragmentFile(artifacts, 'updater-fragment-linux-x86_64', linuxFragment)
    fs.writeFileSync(path.join(root, 'release-notes.md'), 'notes\n')

    const res = run(
      ['merge', '--tag', 'v0.2.1', '--notes', 'release-notes.md', '--fragments-dir', 'artifacts', '--out', 'latest.json'],
      root,
    )
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /missing updater fragment.*windows-x86_64/i)
    assert.equal(fs.existsSync(path.join(root, 'latest.json')), false)
  })

  test('fragment writes a fragment file for the platform', () => {
    const root = tmpdir('cli')
    const dir = path.join(root, 'bundle', PLATFORMS['linux-x86_64'].bundleDir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'DevDeck_0.2.1_amd64.AppImage.sig'), 'LINUXSIG\n')

    const res = run(
      [
        'fragment',
        '--platform',
        'linux-x86_64',
        '--bundle-dir',
        'bundle',
        '--asset-name',
        'devdeck-desktop-linux-amd64.AppImage',
        '--out',
        FRAGMENT_FILENAME,
      ],
      root,
    )
    assert.equal(res.status, 0, res.stderr)

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, FRAGMENT_FILENAME), 'utf8')), {
      platform: 'linux-x86_64',
      signature: 'LINUXSIG',
      assetName: 'devdeck-desktop-linux-amd64.AppImage',
    })
  })

  test('fragment never prints the signature to stdout', () => {
    const root = tmpdir('cli')
    const dir = path.join(root, 'bundle', PLATFORMS['linux-x86_64'].bundleDir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.AppImage.sig'), 'SECRET-LOOKING-BLOB')

    const res = run(
      ['fragment', '--platform', 'linux-x86_64', '--bundle-dir', 'bundle', '--asset-name', 'a.AppImage', '--out', 'f.json'],
      root,
    )
    assert.equal(res.status, 0, res.stderr)
    assert.doesNotMatch(res.stdout + res.stderr, /SECRET-LOOKING-BLOB/)
  })

  test('exits non-zero on an unknown subcommand', () => {
    const res = run(['nope'], tmpdir('cli'))
    assert.notEqual(res.status, 0)
  })
})
