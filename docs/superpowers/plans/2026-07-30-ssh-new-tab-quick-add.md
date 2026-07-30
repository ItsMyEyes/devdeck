# SSH New-Tab Quick-Add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the workspace tab strip's "+" open an SSH shell — picking a saved host or creating a brand new one from a single pasted `ssh user@host -J bastion` command — and reuse that same parsing to pre-fill the existing "Add SSH connection" drawer.

**Architecture:** Two new pure, dependency-light modules under `frontend/src/features/ssh/` carry all the logic: `sshCommand.ts` parses an `ssh(1)` command line into a target hop + jump hops, and `sshQuickAdd.ts` turns that plus a credentials draft into an ordered list of `POST /api/ssh/connections` bodies. Both are covered by plain-assertion tests. The two React surfaces (`NewTabDialog.tsx`, `SSHConnectionDialog.tsx`) stay thin consumers. No backend changes.

**Tech Stack:** TypeScript 5 (strict, `verbatimModuleSyntax`), React 19, zustand (`useDevDeckStore`), TanStack Query (`useCreateSSHConnection`), TanStack Router (`useNavigate`), Tailwind v4 with devdeck tokens, `lucide-react` icons.

**Spec:** `docs/superpowers/specs/2026-07-30-ssh-new-tab-quick-add-design.md`

## Global Constraints

- **No backend changes.** `POST /api/ssh/connections` is used verbatim. Do not touch anything under `backend/`.
- **Imports use the `@/*` alias** for anything crossing out of the current feature folder. Same-folder imports use `./name`. Never relative paths into `src/`.
- **`verbatimModuleSyntax` is on** — every type-only import must use `import type`.
- **No new dependencies.** No test framework, no CLI parser library.
- **All user-facing UI copy is English**, matching every existing string in this app ("New tab", "Choose what to open and which machine to run it on."). The spec's prose is Indonesian; the strings in it are not literal UI copy. Exact strings to use are given in each task.
- **Test style:** plain assertion scripts run with `npx tsx <file>`, copying the header and `check`/`assertEqual` helpers from `frontend/src/features/ssh/jumpHostDraft.test.ts`. This repo has **no** Vitest/Jest/RTL — do not add one.
- **`.tsx` files have no test harness.** Keep logic in the two pure modules so it is testable; the React tasks are gated on `npm run typecheck`, `npm run build`, and an explicit manual checklist.
- **Verification commands** (run from `frontend/`): `npx tsx src/features/ssh/<file>.test.ts`, `npm run typecheck`, `npm run build`.
- **Convergence file warning:** `frontend/src/store/useDevDeckStore.ts` is edited by Task 3 only. No other task may touch it.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/features/ssh/sshCommand.ts` *(new)* | Tokenize and parse an `ssh` command line into `ParsedSSHCommand`. Zero app imports. |
| `frontend/src/features/ssh/sshCommand.test.ts` *(new)* | Assertion tests for the parser. |
| `frontend/src/features/ssh/sshQuickAdd.ts` *(new)* | Quick-add draft shape, validation, name derivation, and the create-request chain builder. |
| `frontend/src/features/ssh/sshQuickAdd.test.ts` *(new)* | Assertion tests for draft validation and plan building. |
| `frontend/src/store/useDevDeckStore.ts` *(modify)* | `NewTabKind` gains `'ssh'`; `NewTabState` gains `sshConnectionId`. |
| `frontend/src/features/tabs/NewTabDialog.tsx` *(modify)* | Third "SSH" kind: host picker + inline quick-add block. |
| `frontend/src/features/tabs/WorkspaceTileArea.tsx` *(modify)* | New `onCreateSSH` callback wired to `openSSHShellTab` + navigate. |
| `frontend/src/features/ssh/SSHConnectionDialog.tsx` *(modify)* | "Paste ssh command" field that fills the create form. |

## Task Dependency Order

```
Task 1 (sshCommand.ts)
        │
        ▼
Task 2 (sshQuickAdd.ts)
        │
        ├──────────────┐
        ▼              ▼
Task 3 (New tab)   Task 4 (Add-connection drawer)
        │              │
        └──────┬───────┘
               ▼
Task 5 (final verification)
```

Tasks 3 and 4 touch disjoint files and may run in parallel.

---

### Task 1: `sshCommand.ts` — parse an ssh command line

**Files:**
- Create: `frontend/src/features/ssh/sshCommand.ts`
- Test: `frontend/src/features/ssh/sshCommand.test.ts`

**Interfaces:**
- Consumes: nothing (no app imports at all — this file must stay dependency-free).
- Produces:
  - `interface ParsedSSHHop { user: string; host: string; port: number }`
  - `interface ParsedSSHCommand { target: ParsedSSHHop; jumps: ParsedSSHHop[]; identityFile: string | null; ignoredFlags: string[] }`
  - `function parseSSHCommand(raw: string): ParsedSSHCommand | null`

**Behaviour contract (what the tests below pin down):**
- A leading literal `ssh` token is optional and case-insensitive.
- Destination is the first non-flag token, in `[user@]host[:port]` form. A second non-flag token begins a remote command — it and everything after it are ignored entirely (not recorded in `ignoredFlags`).
- Flags may appear before *or after* the destination; the spec's own example (`ssh root@10.1.1.1 -J root@2131`) has the flag after.
- Read: `-p`, `-l`, `-i`, `-J` (comma-separated chain), each in both `-pN` and `-p N` spellings. `-J` hops are stored nearest-first, matching `ssh(1)`.
- A jump hop with no user inherits the target's user; with no port gets 22.
- `-p` wins over a `:port` written in the destination (it's the real ssh flag; `host:port` is a convenience the parser accepts but ssh itself does not).
- Value-taking flags that aren't read (`-o`, `-L`, `-R`, `-D`, `-F`, …) consume their value token so it can't be mistaken for the destination. They and valueless unknown flags (`-A`, `-t`, …) are recorded once each in `ignoredFlags`, deduped, as `-X`. Long flags (`--foo`) are recorded verbatim.
- Returns `null` only when there is no destination token at all.
- A host containing more than one `:` (bare IPv6 such as `::1`) is taken verbatim with no port split — bracketed `[::1]:22` syntax is **not** supported and is out of scope.
- `user` may come back empty (e.g. `ssh myhost`). That is a successful parse; `isSSHQuickAddValid` in Task 2 is what rejects it, so a half-typed string still fills the host field.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/ssh/sshCommand.test.ts`:

```ts
/**
 * Plain assertion-based tests, matching jumpHostDraft.test.ts's convention
 * (no Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/ssh/sshCommand.test.ts
 */

import { parseSSHCommand } from './sshCommand'

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

check('parses the spec example: destination first, -J after it', () => {
  const parsed = parseSSHCommand('ssh root@10.1.1.1 -J root@2131')
  assertEqual(parsed?.target, { user: 'root', host: '10.1.1.1', port: 22 }, 'target')
  assertEqual(parsed?.jumps, [{ user: 'root', host: '2131', port: 22 }], 'jumps')
  assertEqual(parsed?.identityFile, null, 'no identity file')
  assertEqual(parsed?.ignoredFlags, [], 'nothing ignored')
})

check('parses a bare user@host with no ssh prefix', () => {
  const parsed = parseSSHCommand('deploy@web.example.com')
  assertEqual(parsed?.target, { user: 'deploy', host: 'web.example.com', port: 22 }, 'target')
  assertEqual(parsed?.jumps, [], 'no jumps')
})

check('a destination with no user parses with an empty user', () => {
  const parsed = parseSSHCommand('ssh myhost')
  assertEqual(parsed?.target, { user: '', host: 'myhost', port: 22 }, 'target')
})

check('reads -p and -l in both attached and detached spellings', () => {
  assertEqual(parseSSHCommand('ssh -p 2222 host')?.target.port, 2222, 'detached -p')
  assertEqual(parseSSHCommand('ssh -p2222 host')?.target.port, 2222, 'attached -p')
  assertEqual(parseSSHCommand('ssh -l deploy host')?.target.user, 'deploy', 'detached -l')
  assertEqual(parseSSHCommand('ssh -ldeploy host')?.target.user, 'deploy', 'attached -l')
})

check('a user@ in the destination beats -l', () => {
  assertEqual(parseSSHCommand('ssh -l ignored root@host')?.target.user, 'root', 'destination user wins')
})

check('accepts host:port in the destination, but -p overrides it', () => {
  assertEqual(parseSSHCommand('ssh root@host:2200')?.target.port, 2200, 'host:port read')
  assertEqual(parseSSHCommand('ssh -p 22 root@host:2200')?.target.port, 22, '-p wins')
})

check('reads -i, including a quoted path with spaces', () => {
  assertEqual(parseSSHCommand('ssh -i ~/.ssh/id_ed25519 root@host')?.identityFile, '~/.ssh/id_ed25519', 'plain path')
  assertEqual(parseSSHCommand('ssh -i "/keys/my key.pem" root@host')?.identityFile, '/keys/my key.pem', 'quoted path')
})

check('reads a multi-hop comma-separated -J, nearest hop first', () => {
  const parsed = parseSSHCommand('ssh root@target -J a@first:2222,b@second')
  assertEqual(
    parsed?.jumps,
    [
      { user: 'a', host: 'first', port: 2222 },
      { user: 'b', host: 'second', port: 22 },
    ],
    'both hops in order',
  )
})

check('a jump hop with no user inherits the target user', () => {
  assertEqual(parseSSHCommand('ssh root@target -J bastion')?.jumps, [{ user: 'root', host: 'bastion', port: 22 }], 'inherited')
})

check('-o consumes its value so it is never mistaken for the destination', () => {
  const parsed = parseSSHCommand('ssh -o StrictHostKeyChecking=no root@host')
  assertEqual(parsed?.target.host, 'host', 'destination is the real host')
  assertEqual(parsed?.ignoredFlags, ['-o'], 'flag recorded')
})

check('unknown valueless flags are recorded once each, deduped', () => {
  const parsed = parseSSHCommand('ssh -A -t -t --config root@host')
  assertEqual(parsed?.target.host, 'host', 'destination found')
  assertEqual(parsed?.ignoredFlags, ['-A', '-t', '--config'], 'deduped, in order')
})

check('a remote command after the destination is ignored entirely', () => {
  const parsed = parseSSHCommand('ssh root@host tail -f /var/log/syslog')
  assertEqual(parsed?.target.host, 'host', 'destination')
  assertEqual(parsed?.ignoredFlags, [], 'the remote command contributes no ignored flags')
})

check('a multi-colon host is taken verbatim with no port split', () => {
  assertEqual(parseSSHCommand('ssh root@::1')?.target, { user: 'root', host: '::1', port: 22 }, 'bare IPv6 host')
})

check('returns null when there is no destination', () => {
  assertEqual(parseSSHCommand('ssh -p 22'), null, 'flags only')
  assertEqual(parseSSHCommand('   '), null, 'blank')
})

console.log(`\n${passed} tests passed`)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npx tsx src/features/ssh/sshCommand.test.ts
```

Expected: FAIL — `Cannot find module './sshCommand'`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/features/ssh/sshCommand.ts`:

```ts
// Parses an ssh(1) command line into the fields an `SSHConnection` needs
// (design: docs/superpowers/specs/2026-07-30-ssh-new-tab-quick-add-design.md).
// Deliberately free of app imports so it can be unit-tested with `npx tsx`,
// like jumpHostDraft.ts next to it.

export interface ParsedSSHHop {
  /** May be empty — the backend requires a username, but an empty one here
   *  blocks submit rather than failing the parse, so a half-typed command
   *  still fills in the host. */
  user: string
  host: string
  port: number
}

export interface ParsedSSHCommand {
  target: ParsedSSHHop
  /** In `-J` order: nearest hop first, matching ssh(1)'s own semantics. */
  jumps: ParsedSSHHop[]
  /** `-i` path, passed through verbatim — it is resolved on the executor
   *  machine, not here, so `~` is deliberately left alone. */
  identityFile: string | null
  /** Recognised-but-unmapped flags, deduped, for the UI's "Ignored: …" note. */
  ignoredFlags: string[]
}

/** Short flags that take a value, whether or not this parser uses it. Listing
 *  the unused ones matters: without it, `-o StrictHostKeyChecking=no host`
 *  would treat `StrictHostKeyChecking=no` as the destination. */
const VALUE_FLAGS = new Set([
  'b', 'c', 'D', 'E', 'e', 'F', 'I', 'i', 'J', 'L', 'l', 'm', 'O', 'o', 'p', 'Q', 'R', 'S', 'W', 'w',
])

/** Whitespace split with single/double-quote grouping, so `-i "/a b/key"`
 *  survives. Escapes are not interpreted — paths, not shell scripts. */
function tokenize(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: string | null = null
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/** `[user@]host[:port]`. Port comes back null when unspecified so callers can
 *  layer their own default (`-p` for the target, 22 for a hop). */
function parseHop(spec: string): { user: string; host: string; port: number | null } | null {
  const trimmed = spec.trim()
  if (!trimmed) return null
  const at = trimmed.lastIndexOf('@')
  const user = at === -1 ? '' : trimmed.slice(0, at)
  let host = at === -1 ? trimmed : trimmed.slice(at + 1)
  if (!host) return null

  // Only a *single* colon means "host:port" — a multi-colon host is a bare
  // IPv6 literal and is taken verbatim.
  const colon = host.indexOf(':')
  let port: number | null = null
  if (colon !== -1 && host.lastIndexOf(':') === colon) {
    const digits = host.slice(colon + 1)
    const value = Number.parseInt(digits, 10)
    if (Number.isInteger(value) && String(value) === digits) {
      port = value
      host = host.slice(0, colon)
    }
  }
  if (!host) return null
  return { user, host, port }
}

export function parseSSHCommand(raw: string): ParsedSSHCommand | null {
  const tokens = tokenize(raw)
  if (tokens[0]?.toLowerCase() === 'ssh') tokens.shift()

  let destination: string | null = null
  let portFlag: number | null = null
  let userFlag = ''
  let identityFile: string | null = null
  const jumpSpecs: string[] = []
  const ignoredFlags: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--') continue
    if (!token.startsWith('-')) {
      // The first bare token is the destination; a second one starts the
      // remote command, which is none of our business.
      if (destination !== null) break
      destination = token
      continue
    }
    if (token.startsWith('--')) {
      ignoredFlags.push(token)
      continue
    }

    const letter = token[1]
    const attached = token.slice(2)
    let value = attached
    if (VALUE_FLAGS.has(letter) && !attached) {
      value = tokens[i + 1] ?? ''
      i += 1
    }

    switch (letter) {
      case 'p': {
        const port = Number.parseInt(value, 10)
        if (Number.isInteger(port)) portFlag = port
        break
      }
      case 'l':
        if (value) userFlag = value
        break
      case 'i':
        if (value) identityFile = value
        break
      case 'J':
        for (const spec of value.split(',')) {
          const trimmed = spec.trim()
          if (trimmed) jumpSpecs.push(trimmed)
        }
        break
      default:
        ignoredFlags.push(`-${letter}`)
    }
  }

  if (!destination) return null
  const parsedTarget = parseHop(destination)
  if (!parsedTarget) return null

  const targetUser = parsedTarget.user || userFlag
  const target: ParsedSSHHop = {
    user: targetUser,
    host: parsedTarget.host,
    // `-p` is the real ssh flag; `host:port` is only a convenience, so the
    // flag wins when both are present.
    port: portFlag ?? parsedTarget.port ?? 22,
  }

  const jumps: ParsedSSHHop[] = []
  for (const spec of jumpSpecs) {
    const hop = parseHop(spec)
    if (!hop) continue
    jumps.push({ user: hop.user || targetUser, host: hop.host, port: hop.port ?? 22 })
  }

  return { target, jumps, identityFile, ignoredFlags: Array.from(new Set(ignoredFlags)) }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd frontend && npx tsx src/features/ssh/sshCommand.test.ts
```

Expected: PASS — `14 tests passed`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/ssh/sshCommand.ts frontend/src/features/ssh/sshCommand.test.ts
git commit -m "feat(ssh): parse an ssh command line into connection fields"
```

---

### Task 2: `sshQuickAdd.ts` — draft, validation, and the create-request chain

**Files:**
- Create: `frontend/src/features/ssh/sshQuickAdd.ts`
- Test: `frontend/src/features/ssh/sshQuickAdd.test.ts`

**Interfaces:**
- Consumes (Task 1): `parseSSHCommand`, `type ParsedSSHCommand`, `type ParsedSSHHop` from `./sshCommand`.
- Consumes (existing code, do not modify): `type CreateSSHConnectionBody` from `@/lib/api`; `type SSHConnection` from `@/store/types`; `type SSHAuthFieldsValue` from `./SSHAuthFields`.
- Produces:
  - `interface SSHQuickAddDraft { raw: string; name: string; nameTouched: boolean; executorMachineId: string; auth: SSHAuthFieldsValue; jumpAuthOverride: boolean; jumpAuth: SSHAuthFieldsValue }`
  - `type QuickAddStep = { kind: 'existing'; id: string } | { kind: 'create'; body: CreateSSHConnectionBody }`
  - `interface QuickAddPlan { steps: QuickAddStep[] }`
  - `function defaultSSHAuthDraft(): SSHAuthFieldsValue`
  - `function defaultSSHQuickAddDraft(): SSHQuickAddDraft`
  - `function deriveSSHQuickAddName(parsed: ParsedSSHCommand): string`
  - `function applyIdentityFile(draft: SSHQuickAddDraft, parsed: ParsedSSHCommand): SSHQuickAddDraft`
  - `function findExistingConnection(hop: ParsedSSHHop, existing: SSHConnection[]): SSHConnection | undefined`
  - `function isSSHQuickAddValid(parsed: ParsedSSHCommand | null, draft: SSHQuickAddDraft, existing: SSHConnection[]): boolean`
  - `function buildSSHQuickAddPlan(parsed: ParsedSSHCommand, draft: SSHQuickAddDraft, existing: SSHConnection[]): QuickAddPlan`

**Design notes the implementer must honour:**
- `SSHAuthFieldsValue` is the *existing* exported interface at `frontend/src/features/ssh/SSHAuthFields.tsx:74` — `{ authType: 'password' | 'privatekey'; password: string; privateKey: string; privateKeyPath: string; passphrase: string }`. Reuse it as the auth draft shape rather than declaring a parallel type, so the drafts drop straight into `<SSHAuthFields {...draft.auth} />`.
- `steps` is ordered **farthest hop first, target last**, so each step's `jumpConnectionId` is simply the id produced by the step before it. `ParsedSSHCommand.jumps` is nearest-first, so the builder reverses it.
- Hop bodies always get `group: ''`, `executorMachineId: null`, `jumpConnectionId: null` (the caller overwrites it) and `name` = `user@host`. `sshmgr.Dialer` runs every hop from the hub regardless of executor — same reasoning as `buildJumpHostRequest` in `jumpHostDraft.ts:42-45`.
- The **target is always a `create` step**, never reused, even if a saved connection matches: the user explicitly chose "new host" and typed a name and credentials for it. Only *hops* are reuse-matched, which is also what makes a retry after a mid-chain failure idempotent.
- Secret fields are emitted exactly like `buildJumpHostRequest`: password auth sends only `password`; private-key auth prefers a pasted `privateKey` over `privateKeyPath`, and sends `passphrase` only when non-empty. Never send a field as an empty string.
- **`nameTouched` is an explicit flag, not something inferred by re-parsing.** The obvious alternative — "the name is auto-derived if it equals what the *previous* raw string derived" — breaks while the user is still typing: `parseSSHCommand('ssh')` returns `null` (a lone `ssh` token with no destination), so as soon as the raw string passes through `"ssh"` and `"ssh "` the comparison has no previous parse to match against and the name freezes at whatever prefix it had. A boolean set by the Name field's own `onChange` has no such hole.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/ssh/sshQuickAdd.test.ts`:

```ts
/**
 * Plain assertion-based tests, matching jumpHostDraft.test.ts's convention
 * (no Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/ssh/sshQuickAdd.test.ts
 */

import type { SSHConnection } from '@/store/types'
import { parseSSHCommand } from './sshCommand'
import {
  applyIdentityFile,
  buildSSHQuickAddPlan,
  defaultSSHQuickAddDraft,
  deriveSSHQuickAddName,
  findExistingConnection,
  isSSHQuickAddValid,
  type SSHQuickAddDraft,
} from './sshQuickAdd'

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

function parse(raw: string) {
  const parsed = parseSSHCommand(raw)
  if (!parsed) throw new Error(`fixture failed to parse: ${raw}`)
  return parsed
}

function draftFor(raw: string, overrides: Partial<SSHQuickAddDraft> = {}): SSHQuickAddDraft {
  const base = defaultSSHQuickAddDraft()
  return {
    ...base,
    raw,
    name: deriveSSHQuickAddName(parse(raw)),
    auth: { ...base.auth, password: 'hunter2' },
    ...overrides,
  }
}

function connection(overrides: Partial<SSHConnection>): SSHConnection {
  return {
    id: 'sc-1',
    name: 'bastion',
    group: '',
    host: 'bastion.example.com',
    port: 22,
    username: 'root',
    authType: 'password',
    jumpConnectionId: null,
    executorMachineId: null,
    hostKeyFingerprint: null,
    ...overrides,
  }
}

check('deriveSSHQuickAddName uses user@host, or the bare host with no user', () => {
  assertEqual(deriveSSHQuickAddName(parse('ssh root@10.1.1.1')), 'root@10.1.1.1', 'with user')
  assertEqual(deriveSSHQuickAddName(parse('ssh myhost')), 'myhost', 'without user')
})

check('a fresh draft is untouched, unnamed, hub-decides, and password-auth', () => {
  const fresh = defaultSSHQuickAddDraft()
  assertEqual(fresh.name, '', 'no name')
  assertEqual(fresh.nameTouched, false, 'name not hand-edited yet')
  assertEqual(fresh.executorMachineId, '', 'hub decides')
  assertEqual(fresh.jumpAuthOverride, false, 'hops reuse the target credentials')
  assertEqual(fresh.auth.authType, 'password', 'password auth by default')
})

check('applyIdentityFile switches to private-key auth and clears a pasted key', () => {
  const before = { ...defaultSSHQuickAddDraft(), auth: { ...defaultSSHQuickAddDraft().auth, privateKey: 'STALE' } }
  const after = applyIdentityFile(before, parse('ssh -i ~/.ssh/id_ed25519 root@host'))
  assertEqual(after.auth.authType, 'privatekey', 'auth type switched')
  assertEqual(after.auth.privateKeyPath, '~/.ssh/id_ed25519', 'path set')
  assertEqual(after.auth.privateKey, '', 'stale pasted key cleared')
})

check('applyIdentityFile leaves the draft untouched when there is no -i', () => {
  const before = defaultSSHQuickAddDraft()
  assertEqual(applyIdentityFile(before, parse('ssh root@host')), before, 'unchanged')
})

check('findExistingConnection matches on host/port/user, host case-insensitively', () => {
  const saved = [connection({ id: 'sc-9', host: 'Bastion.Example.com' })]
  const hop = parse('ssh root@target -J root@bastion.example.com').jumps[0]
  assertEqual(findExistingConnection(hop, saved)?.id, 'sc-9', 'matched')
  assertEqual(findExistingConnection(hop, [connection({ port: 2222 })]), undefined, 'port must match')
  assertEqual(findExistingConnection(hop, [connection({ username: 'deploy' })]), undefined, 'user must match')
})

check('isSSHQuickAddValid rejects a missing username, bad port, and missing secret', () => {
  const base = defaultSSHQuickAddDraft()
  assertEqual(
    isSSHQuickAddValid(parse('ssh myhost'), draftFor('ssh myhost'), []),
    false,
    'no username',
  )
  assertEqual(
    isSSHQuickAddValid(parse('ssh -p 99999 root@host'), draftFor('ssh -p 99999 root@host'), []),
    false,
    'port out of range',
  )
  assertEqual(
    isSSHQuickAddValid(parse('ssh root@host'), { ...draftFor('ssh root@host'), auth: base.auth }, []),
    false,
    'no secret',
  )
  assertEqual(
    isSSHQuickAddValid(parse('ssh root@host'), { ...draftFor('ssh root@host'), name: '  ' }, []),
    false,
    'blank name',
  )
  assertEqual(isSSHQuickAddValid(null, draftFor('ssh root@host'), []), false, 'unparsed command')
  assertEqual(isSSHQuickAddValid(parse('ssh root@host'), draftFor('ssh root@host'), []), true, 'complete draft')
})

check('isSSHQuickAddValid only demands jump credentials when a hop will be created', () => {
  const raw = 'ssh root@target -J root@bastion.example.com'
  const overridden = { ...draftFor(raw), jumpAuthOverride: true }
  assertEqual(isSSHQuickAddValid(parse(raw), overridden, []), false, 'override on, no jump secret')
  assertEqual(
    isSSHQuickAddValid(parse(raw), overridden, [connection({})]),
    true,
    'hop already saved, so the empty jump auth is irrelevant',
  )
})

check('buildSSHQuickAddPlan puts the target last with the draft name and executor', () => {
  const raw = 'ssh root@10.1.1.1'
  const plan = buildSSHQuickAddPlan(parse(raw), { ...draftFor(raw), name: 'prod-web', executorMachineId: 'm-1' }, [])
  assertEqual(plan.steps.length, 1, 'one step')
  const step = plan.steps[0]
  if (step.kind !== 'create') throw new Error('expected a create step')
  assertEqual(step.body.name, 'prod-web', 'draft name used')
  assertEqual(step.body.host, '10.1.1.1', 'host')
  assertEqual(step.body.port, 22, 'port')
  assertEqual(step.body.username, 'root', 'username')
  assertEqual(step.body.executorMachineId, 'm-1', 'executor carried')
  assertEqual(step.body.jumpConnectionId, null, 'caller threads the jump id')
  assertEqual(step.body.password, 'hunter2', 'secret carried')
})

check('an empty executor selection becomes null, not an empty string', () => {
  const raw = 'ssh root@host'
  const plan = buildSSHQuickAddPlan(parse(raw), { ...draftFor(raw), executorMachineId: '' }, [])
  const step = plan.steps[0]
  if (step.kind !== 'create') throw new Error('expected a create step')
  assertEqual(step.body.executorMachineId, null, 'hub decides')
})

check('buildSSHQuickAddPlan orders a multi-hop chain farthest hop first', () => {
  const raw = 'ssh root@target -J root@near,root@far'
  const plan = buildSSHQuickAddPlan(parse(raw), draftFor(raw), [])
  const hosts = plan.steps.map((s) => (s.kind === 'create' ? s.body.host : `existing:${s.id}`))
  assertEqual(hosts, ['far', 'near', 'target'], 'farthest, nearest, target')
})

check('hop bodies are ungrouped, executor-less, and auto-named', () => {
  const raw = 'ssh root@target -J deploy@bastion:2222'
  const plan = buildSSHQuickAddPlan(parse(raw), draftFor(raw), [])
  const hop = plan.steps[0]
  if (hop.kind !== 'create') throw new Error('expected a create step')
  assertEqual(hop.body.name, 'deploy@bastion', 'auto-named')
  assertEqual(hop.body.group, '', 'ungrouped')
  assertEqual(hop.body.port, 2222, 'hop port')
  assertEqual(hop.body.executorMachineId, null, 'no executor on an intermediate hop')
})

check('a saved hop becomes an existing step instead of a duplicate create', () => {
  const raw = 'ssh root@target -J root@bastion.example.com'
  const plan = buildSSHQuickAddPlan(parse(raw), draftFor(raw), [connection({ id: 'sc-7' })])
  assertEqual(plan.steps[0], { kind: 'existing', id: 'sc-7' }, 'reused')
  assertEqual(plan.steps.length, 2, 'reuse plus the target')
})

check('the target is always created even when an identical host is already saved', () => {
  const raw = 'ssh root@bastion.example.com'
  const plan = buildSSHQuickAddPlan(parse(raw), draftFor(raw), [connection({ id: 'sc-7' })])
  assertEqual(plan.steps[0].kind, 'create', 'target never reused')
})

check('hops use the jump credentials only when the override is on', () => {
  const raw = 'ssh root@target -J root@bastion'
  const shared = buildSSHQuickAddPlan(parse(raw), draftFor(raw), []).steps[0]
  if (shared.kind !== 'create') throw new Error('expected a create step')
  assertEqual(shared.body.password, 'hunter2', 'target credentials reused by default')

  const overridden = buildSSHQuickAddPlan(
    parse(raw),
    {
      ...draftFor(raw),
      jumpAuthOverride: true,
      jumpAuth: { authType: 'password', password: 'jumppw', privateKey: '', privateKeyPath: '', passphrase: '' },
    },
    [],
  ).steps[0]
  if (overridden.kind !== 'create') throw new Error('expected a create step')
  assertEqual(overridden.body.password, 'jumppw', 'override applied to the hop')
})

check('private-key auth prefers a pasted key over a path and omits blank fields', () => {
  const raw = 'ssh root@host'
  const plan = buildSSHQuickAddPlan(
    parse(raw),
    {
      ...draftFor(raw),
      auth: {
        authType: 'privatekey',
        password: '',
        privateKey: 'PEMDATA',
        privateKeyPath: '~/.ssh/id_ed25519',
        passphrase: 'shh',
      },
    },
    [],
  )
  const step = plan.steps[0]
  if (step.kind !== 'create') throw new Error('expected a create step')
  assertEqual(step.body.privateKey, 'PEMDATA', 'pasted key wins')
  assertEqual(step.body.privateKeyPath, undefined, 'path omitted')
  assertEqual(step.body.passphrase, 'shh', 'passphrase carried')
  assertEqual(step.body.password, undefined, 'no password field')
})

console.log(`\n${passed} tests passed`)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npx tsx src/features/ssh/sshQuickAdd.test.ts
```

Expected: FAIL — `Cannot find module './sshQuickAdd'`.

> This is the first test file in the repo to import through the `@/*` alias
> (`jumpHostDraft.test.ts` only imports relatively). `frontend/tsconfig.json` is a
> single non-split config that declares the `@/*` path mapping, so plain
> `npx tsx <file>` should resolve it. If it does not, change the `@/` imports in
> the **test file only** to relative paths (`../../store/types`) and note that in
> the commit message — the module under test keeps its `@/` imports either way,
> since the app builds through Vite. Do **not** invent a `tsconfig.app.json`;
> no such file exists here.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/features/ssh/sshQuickAdd.ts`:

```ts
// Draft state, validation, and request-chain building for creating an SSH
// connection (plus any jump hops it needs) from a single pasted ssh command.
// Design: docs/superpowers/specs/2026-07-30-ssh-new-tab-quick-add-design.md.
// Kept out of the components so it is testable without a component-test
// harness, exactly like jumpHostDraft.ts.

import type { CreateSSHConnectionBody } from '@/lib/api'
import type { SSHConnection } from '@/store/types'
import type { SSHAuthFieldsValue } from './SSHAuthFields'
import type { ParsedSSHCommand, ParsedSSHHop } from './sshCommand'

export interface SSHQuickAddDraft {
  /** The raw ssh command as typed. */
  raw: string
  name: string
  /** Set once the user edits the Name field themselves; until then every
   *  keystroke in the command re-derives the name. */
  nameTouched: boolean
  /** '' means "hub decides" — sent as null. */
  executorMachineId: string
  auth: SSHAuthFieldsValue
  /** When false, every created hop reuses `auth`. */
  jumpAuthOverride: boolean
  jumpAuth: SSHAuthFieldsValue
}

export type QuickAddStep =
  | { kind: 'existing'; id: string }
  | { kind: 'create'; body: CreateSSHConnectionBody }

export interface QuickAddPlan {
  /** Farthest hop first, target last, so each step's `jumpConnectionId` is
   *  the id produced by the step before it. */
  steps: QuickAddStep[]
}

export function defaultSSHAuthDraft(): SSHAuthFieldsValue {
  return { authType: 'password', password: '', privateKey: '', privateKeyPath: '', passphrase: '' }
}

export function defaultSSHQuickAddDraft(): SSHQuickAddDraft {
  return {
    raw: '',
    name: '',
    nameTouched: false,
    executorMachineId: '',
    auth: defaultSSHAuthDraft(),
    jumpAuthOverride: false,
    jumpAuth: defaultSSHAuthDraft(),
  }
}

function hopName(hop: ParsedSSHHop): string {
  return hop.user ? `${hop.user}@${hop.host}` : hop.host
}

export function deriveSSHQuickAddName(parsed: ParsedSSHCommand): string {
  return hopName(parsed.target)
}

/** Maps `-i path` onto the private-key auth fields. A path and a pasted key
 *  are mutually exclusive in `buildSSHQuickAddPlan`, so the stale pasted key
 *  is cleared rather than left to silently win. */
export function applyIdentityFile(draft: SSHQuickAddDraft, parsed: ParsedSSHCommand): SSHQuickAddDraft {
  if (!parsed.identityFile) return draft
  return {
    ...draft,
    auth: { ...draft.auth, authType: 'privatekey', privateKey: '', privateKeyPath: parsed.identityFile },
  }
}

export function findExistingConnection(hop: ParsedSSHHop, existing: SSHConnection[]): SSHConnection | undefined {
  return existing.find(
    (c) => c.host.toLowerCase() === hop.host.toLowerCase() && c.port === hop.port && c.username === hop.user,
  )
}

function isPortValid(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** Mirrors isJumpHostDraftValid's secret rule: a password, or a key by paste
 *  or by path. */
function isAuthValid(auth: SSHAuthFieldsValue): boolean {
  return auth.authType === 'password' ? auth.password.length > 0 : Boolean(auth.privateKey || auth.privateKeyPath)
}

export function isSSHQuickAddValid(
  parsed: ParsedSSHCommand | null,
  draft: SSHQuickAddDraft,
  existing: SSHConnection[],
): boolean {
  if (!parsed) return false
  if (!parsed.target.user.trim() || !parsed.target.host.trim() || !isPortValid(parsed.target.port)) return false
  if (parsed.jumps.some((hop) => !hop.user.trim() || !isPortValid(hop.port))) return false
  if (!draft.name.trim()) return false
  if (!isAuthValid(draft.auth)) return false
  // Jump credentials only matter if a hop is actually going to be created.
  const createsHop = parsed.jumps.some((hop) => !findExistingConnection(hop, existing))
  if (createsHop && draft.jumpAuthOverride && !isAuthValid(draft.jumpAuth)) return false
  return true
}

/** Emits the secret fields exactly like buildJumpHostRequest: never a blank
 *  string, and a pasted key beats a path. */
function applyAuth(body: CreateSSHConnectionBody, auth: SSHAuthFieldsValue) {
  if (auth.authType === 'password') {
    body.password = auth.password
    return
  }
  if (auth.privateKey) body.privateKey = auth.privateKey
  else if (auth.privateKeyPath) body.privateKeyPath = auth.privateKeyPath
  if (auth.passphrase) body.passphrase = auth.passphrase
}

export function buildSSHQuickAddPlan(
  parsed: ParsedSSHCommand,
  draft: SSHQuickAddDraft,
  existing: SSHConnection[],
): QuickAddPlan {
  const hopAuth = draft.jumpAuthOverride ? draft.jumpAuth : draft.auth
  const steps: QuickAddStep[] = []

  // `jumps` is nearest-first; the rows must be created farthest-first so each
  // one can point at the row before it.
  for (const hop of [...parsed.jumps].reverse()) {
    const match = findExistingConnection(hop, existing)
    if (match) {
      steps.push({ kind: 'existing', id: match.id })
      continue
    }
    const body: CreateSSHConnectionBody = {
      name: hopName(hop),
      group: '',
      host: hop.host,
      port: hop.port,
      username: hop.user,
      authType: hopAuth.authType,
      // sshmgr.Dialer runs every hop of a chain from the hub regardless of
      // this field, so an executor on an intermediate hop would do nothing.
      executorMachineId: null,
      jumpConnectionId: null,
    }
    applyAuth(body, hopAuth)
    steps.push({ kind: 'create', body })
  }

  // The target is always created, never reuse-matched: the user explicitly
  // asked for a new host and supplied a name and credentials for it.
  const target: CreateSSHConnectionBody = {
    name: draft.name.trim(),
    group: '',
    host: parsed.target.host,
    port: parsed.target.port,
    username: parsed.target.user,
    authType: draft.auth.authType,
    executorMachineId: draft.executorMachineId || null,
    jumpConnectionId: null,
  }
  applyAuth(target, draft.auth)
  steps.push({ kind: 'create', body: target })

  return { steps }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd frontend && npx tsx src/features/ssh/sshQuickAdd.test.ts
```

Expected: PASS — `15 tests passed`.

- [ ] **Step 5: Re-run Task 1's tests to confirm nothing regressed**

```bash
cd frontend && npx tsx src/features/ssh/sshCommand.test.ts
```

Expected: PASS — `14 tests passed`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/ssh/sshQuickAdd.ts frontend/src/features/ssh/sshQuickAdd.test.ts
git commit -m "feat(ssh): build the create-connection chain for a pasted ssh command"
```

---

### Task 3: SSH kind in the New tab dialog

**Files:**
- Modify: `frontend/src/store/useDevDeckStore.ts` — **four** sites: line 50 `NewTabKind`; lines 52-60 `NewTabState`; line 284 `setNewTab` signature; **line 437 the store's own initial `newTab` literal**; line 551 `openNewTab`'s reassignment. There are **two** full `NewTabState` object literals in this file — missing either one is a `tsc` error.
- Modify: `frontend/src/features/tabs/NewTabDialog.tsx` (whole file)
- Modify: `frontend/src/features/tabs/WorkspaceTileArea.tsx` (lines 66-69 and the `<NewTabDialog …/>` at 279-285)

**Interfaces:**
- Consumes (Task 1): `parseSSHCommand` from `@/features/ssh/sshCommand`.
- Consumes (Task 2): `buildSSHQuickAddPlan`, `defaultSSHQuickAddDraft`, `deriveSSHQuickAddName`, `applyIdentityFile`, `findExistingConnection`, `isSSHQuickAddValid`, `type QuickAddPlan` from `@/features/ssh/sshQuickAdd`.
- Consumes (existing): `SSHAuthFields` from `@/features/ssh/SSHAuthFields`; `useSSHConnections`, `useCreateSSHConnection`, `useMachines`, `useMachinesHealth` from `@/features/data/queries`; `openSSHShellTab` from the store.
- Produces: `NewTabDialogProps` gains `onCreateSSH: (connectionId: string) => void`.

**Why the executor lives in the local draft, not the store:** `NewTabDialog` already has an effect (lines 32-36) that defaults `newTab.machineId` to the first machine, because Browser and Spawn shell both *require* a machine. SSH's executor must default to "hub decides" (`''`) instead. Rather than make that effect conditional, the SSH executor is `draft.executorMachineId` in local component state and the shared Machine `Select` is simply not rendered in SSH mode.

- [ ] **Step 1: Widen the store's new-tab state**

In `frontend/src/store/useDevDeckStore.ts`:

Line 50 — add the third kind:

```ts
export type NewTabKind = 'browser' | 'shell' | 'ssh'
```

In `interface NewTabState` (lines 52-60), add a field after `machineId`:

```ts
  /** SSH kind only: the saved connection to open, or `NEW_SSH_HOST` for the
   *  inline "create from an ssh command" form. Empty until the dialog's own
   *  default-selection effect picks one. */
  sshConnectionId: string
```

Line 284 — widen the patch type:

```ts
  setNewTab: (patch: Partial<Pick<NewTabState, 'kind' | 'machineId' | 'sshConnectionId'>>) => void
```

Lines 550-551 — reset it on open:

```ts
      openNewTab: (wsId, leafId) =>
        set(
          (s) =>
            void (s.newTab = { open: true, wsId, leafId, kind: 'browser', machineId: '', sshConnectionId: '' }),
        ),
```

**And the second literal — easy to miss.** The store's own initial state (inside
`create<DevDeckState>()(…)`, around line 437 before these edits) builds a full
`NewTabState` too. `sshConnectionId` is a required field, so leaving this one
alone is a hard `tsc` error (`TS2345: Property 'sshConnectionId' is missing …`):

```ts
      newTab: { open: false, wsId: null, leafId: null, kind: 'browser', machineId: '', sshConnectionId: '' },
```

- [ ] **Step 2: Verify the store change compiles**

```bash
cd frontend && npm run typecheck
```

Expected: PASS. If it fails with `TS2345: Property 'sshConnectionId' is missing in type
'{ open: false; wsId: null; … }'`, the initial-state literal above was missed.

- [ ] **Step 3: Rewrite `NewTabDialog.tsx`**

Replace the whole file with:

```tsx
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Check, Globe, Loader2, Network, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useCreateSSHConnection, useMachines, useMachinesHealth, useSSHConnections } from '@/features/data/queries'
import { SSHAuthFields } from '@/features/ssh/SSHAuthFields'
import { parseSSHCommand } from '@/features/ssh/sshCommand'
import {
  applyIdentityFile,
  buildSSHQuickAddPlan,
  defaultSSHQuickAddDraft,
  deriveSSHQuickAddName,
  findExistingConnection,
  isSSHQuickAddValid,
  type QuickAddPlan,
} from '@/features/ssh/sshQuickAdd'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { Project } from '@/store/types'

/** Sentinel for "create a host from an ssh command", mirroring
 *  SSHConnectionDialog's own `ADD_NEW_JUMP` option so "existing or new" stays
 *  one control instead of a separate mode switch. */
const NEW_SSH_HOST = '__new__'
/** Empty executor id — the hub picks which machine dials. */
const HUB_DECIDES = ''

interface NewTabDialogProps {
  wsId: string
  projects: Project[]
  currentProjectId?: string
  onCreateBrowser: (machineId: string) => void
  onCreateShell: (projectId: string) => void
  onCreateSSH: (connectionId: string) => void
}

/** The tab strip's "+" chooser: pick Browser, Spawn shell, or SSH. Browser and
 *  Spawn shell need a machine to run on, defaulted to the first registered one
 *  so Create isn't blocked on an empty selection. SSH instead picks a saved
 *  host — or creates one on the spot from a pasted `ssh user@host -J bastion`
 *  command. */
export function NewTabDialog({
  wsId,
  projects,
  currentProjectId,
  onCreateBrowser,
  onCreateShell,
  onCreateSSH,
}: NewTabDialogProps) {
  const newTab = useDevDeckStore((s) => s.newTab)
  const closeNewTab = useDevDeckStore((s) => s.closeNewTab)
  const setNewTab = useDevDeckStore((s) => s.setNewTab)
  const showToast = useDevDeckStore((s) => s.showToast)
  const machines = useMachines().data ?? []
  const machineHealth = useMachinesHealth(machines)
  const connectionsQuery = useSSHConnections()
  const connections = connectionsQuery.data ?? []
  const createConnection = useCreateSSHConnection()
  const [draft, setDraft] = useState(defaultSSHQuickAddDraft())
  const open = newTab.open && newTab.wsId === wsId

  useEffect(() => {
    if (open && !newTab.machineId && machines.length > 0) {
      setNewTab({ machineId: machines[0].id })
    }
  }, [open, newTab.machineId, machines, setNewTab])

  // Default the host picker once the connection list has actually loaded: the
  // first saved host, or the quick-add form when there are none. The
  // `isLoading` guard matters — `.data ?? []` is an empty array while the query
  // is still in flight, and committing `NEW_SSH_HOST` from that would stick:
  // the `newTab.sshConnectionId` truthiness guard stops this effect from ever
  // re-running once it has written something.
  useEffect(() => {
    if (!open || newTab.kind !== 'ssh' || newTab.sshConnectionId || connectionsQuery.isLoading) return
    setNewTab({ sshConnectionId: connections[0]?.id ?? NEW_SSH_HOST })
  }, [open, newTab.kind, newTab.sshConnectionId, connections, connectionsQuery.isLoading, setNewTab])

  // A fresh dialog starts with a fresh quick-add draft — credentials must not
  // survive a close/reopen.
  useEffect(() => {
    if (!open) setDraft(defaultSSHQuickAddDraft())
  }, [open])

  const parsed = useMemo(() => parseSSHCommand(draft.raw), [draft.raw])
  const busy = createConnection.isPending

  const machineOptions = machines.map((m) => ({
    value: m.id,
    label: m.name,
    disabled: machineHealth.get(m.id)?.status === 'offline',
  }))
  const executorOptions = [{ value: HUB_DECIDES, label: 'Hub decides' }, ...machineOptions]
  const hostOptions = [
    { value: NEW_SSH_HOST, label: '+ New host from ssh command…' },
    ...connections.map((c) => ({ value: c.id, label: c.name })),
  ]

  const shellProjects = projects.filter((p) => p.machineId === newTab.machineId)
  const shellProject = shellProjects.find((p) => p.id === currentProjectId) ?? shellProjects[0]
  const addingSSHHost = newTab.sshConnectionId === NEW_SSH_HOST
  // Only offer the "different credentials" toggle when a hop will actually be
  // created — an already-saved bastion brings its own.
  const createsHop = (parsed?.jumps ?? []).some((hop) => !findExistingConnection(hop, connections))

  // `busy` gates every branch, not just the SSH one: an in-flight create chain
  // must not be overtaken by a second Create in another kind.
  const canCreate =
    !busy &&
    (newTab.kind === 'ssh'
      ? addingSSHHost
        ? isSSHQuickAddValid(parsed, draft, connections)
        : Boolean(newTab.sshConnectionId)
      : !!newTab.machineId && (newTab.kind === 'browser' || !!shellProject))

  function handleRawChange(raw: string) {
    setDraft((d) => {
      const next = { ...d, raw }
      const parsedNext = parseSSHCommand(raw)
      if (!parsedNext) return next
      // Re-derive the name only while the user hasn't typed their own.
      const name = d.nameTouched ? d.name : deriveSSHQuickAddName(parsedNext)
      return applyIdentityFile({ ...next, name }, parsedNext)
    })
  }

  /** Runs the plan in order, threading each created row's id into the next
   *  step's `jumpConnectionId`. Returns the target connection's id. */
  async function runPlan(plan: QuickAddPlan): Promise<string> {
    let previousId: string | null = null
    for (const step of plan.steps) {
      if (step.kind === 'existing') {
        previousId = step.id
        continue
      }
      const created = await createConnection.mutateAsync({ ...step.body, jumpConnectionId: previousId })
      previousId = created.id
    }
    // buildSSHQuickAddPlan always ends with a `create` step for the target.
    return previousId as string
  }

  async function submit() {
    if (!canCreate) return

    if (newTab.kind === 'ssh') {
      if (!addingSSHHost) {
        closeNewTab()
        onCreateSSH(newTab.sshConnectionId)
        return
      }
      if (!parsed) return
      try {
        const connectionId = await runPlan(buildSSHQuickAddPlan(parsed, draft, connections))
        closeNewTab()
        showToast(`Added SSH connection "${draft.name.trim()}"`)
        onCreateSSH(connectionId)
      } catch (err) {
        // Hops created before the failure stay saved on purpose — a retry
        // reuse-matches them instead of duplicating them.
        showToast(err instanceof Error ? err.message : 'Failed to add SSH connection')
      }
      return
    }

    closeNewTab()
    if (newTab.kind === 'browser') onCreateBrowser(newTab.machineId)
    else if (shellProject) onCreateShell(shellProject.id)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && closeNewTab()} width={440}>
      <DialogTitle>New tab</DialogTitle>
      <DialogDescription className="mb-4">Choose what to open and where to run it.</DialogDescription>

      {/* Locked while a create chain is in flight — switching kind mid-chain
          would re-enable Create for a different kind and let a second tab open
          on top of the one the pending chain is about to produce. */}
      <div className="mb-4 flex gap-1.5 rounded-lg border border-devdeck-border-strong bg-devdeck-bg p-1">
        <KindTab active={newTab.kind === 'browser'} disabled={busy} onClick={() => setNewTab({ kind: 'browser' })}>
          <Globe size={13} />
          Browser
        </KindTab>
        <KindTab active={newTab.kind === 'shell'} disabled={busy} onClick={() => setNewTab({ kind: 'shell' })}>
          <TerminalSquare size={13} />
          Spawn shell
        </KindTab>
        <KindTab active={newTab.kind === 'ssh'} disabled={busy} onClick={() => setNewTab({ kind: 'ssh' })}>
          <Network size={13} />
          SSH
        </KindTab>
      </div>

      {newTab.kind === 'ssh' ? (
        <div className="mb-5">
          <Label>Host</Label>
          <Select
            value={newTab.sshConnectionId}
            onValueChange={(v) => setNewTab({ sshConnectionId: v })}
            options={hostOptions}
            disabled={busy}
            aria-label="Host"
          />

          {addingSSHHost ? (
            <div className="mt-3 rounded-[12px] border border-devdeck-border-card bg-devdeck-surface-2 p-3">
              <Label>ssh command</Label>
              <Input
                value={draft.raw}
                disabled={busy}
                onChange={(e) => handleRawChange(e.target.value)}
                placeholder="ssh root@10.1.1.1 -J root@bastion"
                className="mb-1.5 font-mono"
                aria-label="ssh command"
              />
              {parsed ? (
                <p className="mb-3 font-mono text-[11px] leading-snug text-devdeck-dim">
                  {parsed.target.user || '(no user)'}@{parsed.target.host}:{parsed.target.port}
                  {parsed.jumps.length > 0
                    ? ` · via ${parsed.jumps.map((hop) => `${hop.user}@${hop.host}`).join(' → ')}`
                    : ''}
                  {parsed.ignoredFlags.length > 0 ? ` · ignored: ${parsed.ignoredFlags.join(' ')}` : ''}
                </p>
              ) : draft.raw.trim() ? (
                <p className="mb-3 font-mono text-[11px] text-devdeck-red-soft">Can't read that ssh command.</p>
              ) : (
                <p className="mb-3 font-mono text-[11px] text-devdeck-dim">
                  Paste a full command — user, port, -i and -J are read from it.
                </p>
              )}
              {parsed && !parsed.target.user ? (
                <p className="mb-3 font-mono text-[11px] text-devdeck-red-soft">
                  No username in that command — add one as user@host or -l user.
                </p>
              ) : null}

              <Label>Name</Label>
              <Input
                value={draft.name}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value, nameTouched: true }))}
                placeholder="prod-web"
                className="mb-3 font-mono"
              />

              <Label>Executor machine</Label>
              <Select
                value={draft.executorMachineId}
                onValueChange={(v) => setDraft((d) => ({ ...d, executorMachineId: v }))}
                options={executorOptions}
                disabled={busy}
                aria-label="Executor machine"
                className="mb-3"
              />

              <SSHAuthFields
                authType={draft.auth.authType}
                password={draft.auth.password}
                privateKey={draft.auth.privateKey}
                privateKeyPath={draft.auth.privateKeyPath}
                passphrase={draft.auth.passphrase}
                onChange={(patch) => setDraft((d) => ({ ...d, auth: { ...d.auth, ...patch } }))}
                disabled={busy}
              />

              {createsHop ? (
                <>
                  <CheckboxRow
                    checked={draft.jumpAuthOverride}
                    disabled={busy}
                    onChange={(checked) => setDraft((d) => ({ ...d, jumpAuthOverride: checked }))}
                    label="Jump host uses different credentials"
                  />
                  {draft.jumpAuthOverride ? (
                    <div className="mt-2.5 rounded-lg border border-devdeck-border-strong bg-devdeck-bg p-2.5">
                      <SSHAuthFields
                        authType={draft.jumpAuth.authType}
                        password={draft.jumpAuth.password}
                        privateKey={draft.jumpAuth.privateKey}
                        privateKeyPath={draft.jumpAuth.privateKeyPath}
                        passphrase={draft.jumpAuth.passphrase}
                        onChange={(patch) => setDraft((d) => ({ ...d, jumpAuth: { ...d.jumpAuth, ...patch } }))}
                        disabled={busy}
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : connections.length === 0 ? (
            <p className="mt-1.5 font-mono text-[11px] text-devdeck-dim">No saved hosts yet.</p>
          ) : null}
        </div>
      ) : (
        <div className="mb-5">
          <Label>Machine</Label>
          {machines.length === 0 ? (
            <p className="mt-1 font-mono text-[11px] text-devdeck-dim">Add a machine first.</p>
          ) : (
            <Select
              value={newTab.machineId}
              onValueChange={(v) => setNewTab({ machineId: v })}
              options={machineOptions}
              aria-label="Machine"
            />
          )}
          {newTab.kind === 'shell' && newTab.machineId && !shellProject ? (
            <p className="mt-1.5 font-mono text-[11px] text-devdeck-red-soft">No project on this machine yet.</p>
          ) : null}
        </div>
      )}

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={closeNewTab} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={!canCreate}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          Create →
        </Button>
      </div>
    </Dialog>
  )
}

function KindTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-[30px] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[12px] font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        active ? 'bg-primary text-primary-foreground' : 'bg-transparent text-devdeck-muted hover:text-devdeck-fg',
      )}
    >
      {children}
    </button>
  )
}

/** There is no shared Checkbox in components/ui — this matches the inline
 *  checkbox button TodosModule already uses for its done toggle. */
function CheckboxRow({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="mt-1 flex cursor-pointer items-center gap-2 text-left disabled:opacity-50"
    >
      <span
        className={cn(
          'flex h-[15px] w-[15px] flex-none items-center justify-center rounded-[4px] border transition-colors',
          checked
            ? 'border-devdeck-accent bg-primary text-primary-foreground'
            : 'border-devdeck-border-strong text-transparent',
        )}
      >
        <Check size={10} strokeWidth={3} />
      </span>
      <span className="text-[11.5px] text-devdeck-fg-2">{label}</span>
    </button>
  )
}
```

- [ ] **Step 4: Wire `onCreateSSH` in `WorkspaceTileArea.tsx`**

After `handleCreateBrowser` (lines 66-69), add:

```tsx
  function handleCreateSSH(connectionId: string) {
    openSSHShellTab(wsId, connectionId)
    navigate({ to: '/w/$wsId', params: { wsId } })
  }
```

Add the store selector next to the other ones (near line 42):

```tsx
  const openSSHShellTab = useDevDeckStore((s) => s.openSSHShellTab)
```

And pass the new prop on the `<NewTabDialog …/>` at lines 279-285:

```tsx
      <NewTabDialog
        wsId={wsId}
        projects={workspace?.projects ?? []}
        currentProjectId={currentProjectId}
        onCreateBrowser={handleCreateBrowser}
        onCreateShell={(projectId) => openSpawn(projectId, 'root')}
        onCreateSSH={handleCreateSSH}
      />
```

- [ ] **Step 5: Verify it compiles and builds**

```bash
cd frontend && npm run typecheck && npm run build
```

Expected: both PASS.

- [ ] **Step 6: Manual verification checklist**

Start the app (`npm run dev` from `frontend/`), open a workspace, click the tab strip's **+** (or press Cmd/Ctrl+T outside a worktree terminal) and confirm:

1. Three kind tabs render: Browser, Spawn shell, SSH.
2. Browser and Spawn shell behave exactly as before (machine picker required, same Create behaviour).
3. SSH shows a **Host** select. With saved hosts, the first is preselected and Create opens that host's shell tab. With none, `+ New host from ssh command…` is preselected.
4. Typing `ssh root@10.1.1.1 -J root@bastion` fills Name with `root@10.1.1.1` and shows the summary line `root@10.1.1.1:22 · via root@bastion`.
5. Editing Name by hand, then editing the command again, does **not** overwrite the hand-typed name.
6. Typing `ssh -i ~/.ssh/id_ed25519 root@host` switches the auth field to Private key with the path prefilled, and Create becomes enabled with nothing else typed.
7. `ssh -A -o Foo=bar root@host` shows `· ignored: -A -o` and still parses the host correctly.
8. Create with a jump host produces **two** new rows in the SSH Connections page, the target's "Connect via" pointing at the bastion.
9. Re-running the same command a second time reuses the bastion row (only one new row appears).
10. Closing and reopening the dialog clears the command and the password field.
11. With saved hosts present, opening the dialog on a cold page load (hard-refresh, then immediately press Cmd/Ctrl+T → SSH) still preselects a saved host — not `+ New host from ssh command…`.
12. While a multi-hop create is in flight, all three kind tabs and the Create button are disabled until it finishes.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/store/useDevDeckStore.ts frontend/src/features/tabs/NewTabDialog.tsx frontend/src/features/tabs/WorkspaceTileArea.tsx
git commit -m "feat(tabs): open an SSH shell from New tab, with inline host creation"
```

---

### Task 4: Paste-to-fill in the Add SSH connection drawer

**Files:**
- Modify: `frontend/src/features/ssh/SSHConnectionDialog.tsx` (imports at lines 1-19; local state near line 35; the reset effect at 38-40; the Name input's `onChange` at line 178; the body's first field at line 174)

**Interfaces:**
- Consumes (Task 1): `parseSSHCommand` from `./sshCommand`.
- Consumes (Task 2): `deriveSSHQuickAddName`, `findExistingConnection` from `./sshQuickAdd`.
- Consumes (existing, unchanged): `defaultJumpHostDraft`, `isJumpHostDraftValid`, `buildJumpHostRequest` from `./jumpHostDraft`; `setDialog` (`setSSHDialog`) from the store.
- Produces: nothing consumed by other tasks.

**Design notes:**
- The field renders only when `!isEdit`. An edit already has a host; silently rewriting it on paste would be a trap.
- The raw string is local component state (`pasteRaw`), not store state — it is scratch input, like `jumpDraft` already is.
- Name is only overwritten while the user hasn't typed one themselves, tracked by a local `nameTouched` flag set from the Name field's own `onChange` — same reason as Task 2's note: inferring it by re-parsing the previous raw string breaks the moment the string passes through `"ssh"`, which parses to `null`.
- Only the **nearest** hop is prefilled. The inline jump mini-form hard-codes `jumpConnectionId: null` (`jumpHostDraft.ts:46-56`) and can only produce one hop; chains belong to the New-tab quick-add path.

- [ ] **Step 1: Add the imports and local state**

Add to the existing import block (keep `./jumpHostDraft` and `./SSHAuthFields` as they are):

```tsx
import { parseSSHCommand } from './sshCommand'
import { deriveSSHQuickAddName, findExistingConnection } from './sshQuickAdd'
```

Next to `const [jumpDraft, setJumpDraft] = useState(defaultJumpHostDraft())` (line 36), add:

```tsx
  const [pasteRaw, setPasteRaw] = useState('')
  const [extraHops, setExtraHops] = useState(0)
  const [nameTouched, setNameTouched] = useState(false)
```

Extend the reset effect (lines 38-40) so scratch input never survives a close:

```tsx
  useEffect(() => {
    if (!dialog.open) {
      setAddingJump(false)
      setPasteRaw('')
      setExtraHops(0)
      setNameTouched(false)
    }
  }, [dialog.open])
```

Mark the Name field as hand-edited. Change its existing `onChange` (line 178) from
`onChange={(e) => setDialog({ name: e.target.value })}` to:

```tsx
          onChange={(e) => {
            setNameTouched(true)
            setDialog({ name: e.target.value })
          }}
```

- [ ] **Step 2: Add the paste handler**

Add above `handleJumpChange` (line 79):

```tsx
  /** Fills the form from a pasted `ssh …` command. Everything it writes stays
   *  visible and editable — this is a shortcut for typing, not a replacement
   *  for the form. */
  function handlePasteChange(raw: string) {
    const parsed = parseSSHCommand(raw)
    setPasteRaw(raw)
    if (!parsed) {
      setExtraHops(0)
      return
    }

    const patch: Parameters<typeof setDialog>[0] = {
      host: parsed.target.host,
      port: String(parsed.target.port),
      username: parsed.target.user,
    }
    if (!nameTouched) patch.name = deriveSSHQuickAddName(parsed)
    if (parsed.identityFile) {
      patch.authType = 'privatekey'
      patch.privateKey = ''
      patch.privateKeyPath = parsed.identityFile
    }

    const nearest = parsed.jumps[0]
    setExtraHops(Math.max(parsed.jumps.length - 1, 0))
    if (nearest) {
      const match = findExistingConnection(nearest, connections)
      if (match) {
        patch.jumpConnectionId = match.id
        setAddingJump(false)
      } else {
        // Prefill the mini-form that already exists rather than inventing a
        // second path to create a hop — only the secret is left to type.
        setJumpDraft({
          ...defaultJumpHostDraft(),
          host: nearest.host,
          username: nearest.user,
          port: String(nearest.port),
        })
        setAddingJump(true)
        patch.jumpConnectionId = ''
      }
    } else {
      // Jump state is derived from the *current* command, so deleting the -J
      // clause has to retract it. Without this branch, editing
      // "ssh a@b -J c@d" down to "ssh a@b" would leave the prefilled jump
      // mini-form open (or a stale jumpConnectionId selected) with nothing in
      // the command asking for it.
      setAddingJump(false)
      patch.jumpConnectionId = ''
    }
    setDialog(patch)
  }
```

- [ ] **Step 3: Render the field at the top of the drawer body**

Immediately after `<div className="flex-1 overflow-auto p-[18px]">` (line 173) and before the existing `<Label>Name</Label>`, insert:

```tsx
        {!isEdit ? (
          <div className="mb-4 rounded-[12px] border border-devdeck-border-card bg-devdeck-surface-2 p-3">
            <Label>Paste ssh command</Label>
            <Input
              value={pasteRaw}
              disabled={busy}
              onChange={(e) => handlePasteChange(e.target.value)}
              placeholder="ssh root@10.1.1.1 -J root@bastion"
              className="font-mono"
              aria-label="Paste ssh command"
            />
            {pasteRaw.trim() && !parseSSHCommand(pasteRaw) ? (
              <p className="mt-1.5 font-mono text-[11px] text-devdeck-red-soft">Can't read that ssh command.</p>
            ) : (
              <p className="mt-1.5 font-mono text-[11px] leading-snug text-devdeck-dim">
                Fills Host, Port, Username, Name — plus the key path from -i and the jump host from -J.
              </p>
            )}
            {extraHops > 0 ? (
              <p className="mt-1.5 font-mono text-[11px] text-devdeck-fg-2">
                Only the nearest jump host was filled in. Create the {extraHops} outer hop
                {extraHops > 1 ? 's' : ''} first, then chain them here.
              </p>
            ) : null}
          </div>
        ) : null}
```

- [ ] **Step 4: Verify it compiles and builds**

```bash
cd frontend && npm run typecheck && npm run build
```

Expected: both PASS.

- [ ] **Step 5: Manual verification checklist**

Open SSH Connections → **Add**, and confirm:

1. The "Paste ssh command" block only appears when adding, never when editing an existing host.
2. Pasting `ssh -p 2222 deploy@web.example.com` fills Host `web.example.com`, Port `2222`, Username `deploy`, Name `deploy@web.example.com`.
3. Typing a Name by hand, then editing the pasted command, leaves the hand-typed name alone.
4. `ssh -i ~/.ssh/id_ed25519 root@host` flips Auth method to Private key with the path prefilled.
5. `-J` naming an already-saved host sets "Connect via" to that host.
6. `-J` naming an unknown host opens the inline jump mini-form with Host/Username/Port prefilled, so only the secret is missing.
7. A two-hop `-J a@x,b@y` shows the "Only the nearest jump host was filled in. Create the 1 outer hop first…" note.
8. Deleting the ` -J …` clause back out of the command closes the inline jump mini-form and resets "Connect via" to Direct connection.
9. Submitting still works end-to-end and the new host appears in the list.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/ssh/SSHConnectionDialog.tsx
git commit -m "feat(ssh): fill the add-connection form from a pasted ssh command"
```

---

### Task 5: Final verification

**Files:** none modified.

- [ ] **Step 1: Run both test suites**

```bash
cd frontend && npx tsx src/features/ssh/sshCommand.test.ts && npx tsx src/features/ssh/sshQuickAdd.test.ts
```

Expected: both print their `N tests passed` line with no failures.

- [ ] **Step 2: Run the pre-existing SSH and tile tests to confirm no regression**

```bash
cd frontend && npx tsx src/features/ssh/jumpHostDraft.test.ts && npx tsx src/features/tabs/tileTree.ssh.test.ts
```

Expected: both PASS.

- [ ] **Step 3: Typecheck and build**

```bash
cd frontend && npm run typecheck && npm run build
```

Expected: both PASS.

- [ ] **Step 4: Confirm the backend was not touched**

```bash
git diff --name-only main...HEAD -- backend/
```

Expected: empty output.

- [ ] **Step 5: Commit anything outstanding**

```bash
git status --short
```

Expected: clean, or only intentional leftovers. If the working tree is clean, nothing to commit.

## Deliberate deviations from the spec

Record these in the final report so the reviewer isn't surprised:

- **No `SSHAuthDraft` interface.** The spec declared one; `sshQuickAdd.ts` reuses the existing exported `SSHAuthFieldsValue` (`SSHAuthFields.tsx:74`) instead, which has exactly that shape. Drafts then spread straight into `<SSHAuthFields …/>` with no duplicate type to keep in sync.
- **`isSSHQuickAddValid` takes a third parameter.** The spec wrote `(parsed, draft)`. It is `(parsed, draft, existing: SSHConnection[])` here, because the spec's own rule — demand jump credentials "only when a hop will actually be created" — cannot be evaluated without the saved-connection list to reuse-match against.
- **"Has the user typed their own name?" is an explicit flag, not inferred.** The spec's wording ("name only while it is still empty or still equal to the previously derived one") describes re-parsing the previous raw string. That fails while typing, because `parseSSHCommand('ssh')` is `null` — see the note in Task 2. Both surfaces use a `nameTouched` boolean set by the Name field instead.
- **No bespoke "collapsed auth summary" for `-i`.** The spec described the auth block shrinking to a `Using key ~/.ssh/id_rsa` line. Instead, `SSHAuthFields` is rendered with `authType: 'privatekey'` and `privateKeyPath` prefilled — the user sees the real, editable path in the field that already exists. Same outcome (nothing left to type), no new widget.
- **The SSH executor lives in local draft state, not `newTab.machineId`.** See the rationale in Task 3; the store still only gains `sshConnectionId`.
