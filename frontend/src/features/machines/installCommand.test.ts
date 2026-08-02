/**
 * Plain assertion-based tests for installCommand.ts.
 *
 * No test runner (Vitest/Jest) is configured in this frontend project, so
 * this is a standalone script: every `check()` call throws on failure,
 * `main()` runs them all and prints a pass count. Run manually with:
 *
 *   npx tsx src/features/machines/installCommand.test.ts
 */

import { buildInstallCommand } from './installCommand'

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

function assertContains(haystack: string, needle: string, message: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`assertion failed: ${message} (expected to find ${JSON.stringify(needle)} in ${JSON.stringify(haystack)})`)
  }
}

const full = {
  hubUrl: 'https://hub.tail-x.ts.net',
  hubKey: 'a1b2c3',
  machineName: 'builder',
}

check('curl command has the expected shape', () => {
  const cmd = buildInstallCommand({ ...full, target: 'curl' })
  assertContains(cmd, 'curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh |', 'curl fetcher')
  assertContains(cmd, "DEVDECK_HUB_URL='https://hub.tail-x.ts.net'", 'hub url env')
  assertContains(cmd, "DEVDECK_HUB_KEY='a1b2c3'", 'hub key env')
  assertContains(cmd, "DEVDECK_MACHINE_NAME='builder' sh", 'name env and shell')
})

check('wget command swaps only the fetcher', () => {
  const cmd = buildInstallCommand({ ...full, target: 'wget' })
  assertContains(cmd, 'wget -qO- https://kiyora.is-a.dev/devdeck/install.sh |', 'wget fetcher')
  assertContains(cmd, "DEVDECK_MACHINE_NAME='builder' sh", 'name env and shell')
  if (cmd.includes('curl')) throw new Error('assertion failed: wget command must not mention curl')
})

check('powershell command uses $env: assignments and irm | iex', () => {
  const cmd = buildInstallCommand({ ...full, target: 'powershell' })
  assertContains(cmd, "$env:DEVDECK_HUB_URL='https://hub.tail-x.ts.net'", 'hub url env')
  assertContains(cmd, "$env:DEVDECK_HUB_KEY='a1b2c3'", 'hub key env')
  assertContains(cmd, "$env:DEVDECK_MACHINE_NAME='builder'", 'name env')
  assertContains(cmd, 'irm https://kiyora.is-a.dev/devdeck/install.ps1 | iex', 'ps1 invocation')
  if (cmd.includes('\n')) throw new Error('assertion failed: the powershell command must be a single line')
})

check('empty values fall back to placeholders', () => {
  const cmd = buildInstallCommand({
    target: 'curl',
    hubUrl: '',
    hubKey: '',
    machineName: '',
  })
  assertContains(cmd, "DEVDECK_HUB_URL='<hub-url>'", 'hub url placeholder')
  assertContains(cmd, "DEVDECK_HUB_KEY='<your-hub-key>'", 'hub key placeholder')
  assertContains(cmd, "DEVDECK_MACHINE_NAME='<name>'", 'name placeholder')
})

check('whitespace-only values fall back to placeholders too', () => {
  const cmd = buildInstallCommand({ ...full, target: 'curl', machineName: '   ' })
  assertContains(cmd, "DEVDECK_MACHINE_NAME='<name>'", 'blank name placeholder')
})

// Machine names are free text. Unquoted, "my box" would split into two
// arguments and the install would register the wrong name — or fail outright.
check('a name with a space stays a single POSIX argument', () => {
  const cmd = buildInstallCommand({ ...full, target: 'curl', machineName: 'my box' })
  assertContains(cmd, "DEVDECK_MACHINE_NAME='my box' sh", 'quoted name')
})

// An apostrophe terminates a POSIX single-quoted run, so it has to be closed,
// escaped, and reopened.
check("a name with an apostrophe is escaped for POSIX", () => {
  const cmd = buildInstallCommand({ ...full, target: 'curl', machineName: "o'brien" })
  assertContains(cmd, `DEVDECK_MACHINE_NAME='o'\\''brien' sh`, 'escaped apostrophe')
})

// PowerShell escapes an embedded single quote by doubling it instead.
check('a name with an apostrophe is doubled for PowerShell', () => {
  const cmd = buildInstallCommand({ ...full, target: 'powershell', machineName: "o'brien" })
  assertContains(cmd, `$env:DEVDECK_MACHINE_NAME='o''brien'`, 'doubled apostrophe')
})

check('quoting applies to the hub key too, not just the name', () => {
  const cmd = buildInstallCommand({ ...full, target: 'curl', hubKey: "k'ey" })
  assertContains(cmd, `DEVDECK_HUB_KEY='k'\\''ey'`, 'escaped hub key')
})

assertEqual(passed, 9, 'all checks ran')
console.log(`\n${passed} passed`)
