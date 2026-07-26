# SSH jump host: create one inline from "Connect via" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the "Connect via" step in `SSHConnectionDialog` create a brand-new jump host inline (host/port/username/auth), instead of requiring the user to save it as a separate top-level connection first and reopen the target connection to select it.

**Architecture:** Extract the dialog's private-key UI into a standalone `SSHAuthFields` component (needed twice once the mini-form exists), extract the mini-form's validation/request-building into pure, unit-tested functions in `jumpHostDraft.ts`, then wire a new sentinel option into the existing "Connect via" `<Select>` that reveals an inline form built from those two pieces.

**Tech Stack:** React 19 + TypeScript (`verbatimModuleSyntax`), TanStack Query (`useCreateSSHConnection`), zustand (`useDevDeckStore`), `@base-ui/react` `Select`, Tailwind v4. Plain assertion-based tests run via `npx tsx` (no Vitest/Jest configured in this repo).

Spec: `docs/superpowers/specs/2026-07-26-ssh-jump-host-manual-add-design.md`

## Global Constraints

- Frontend-only change. No backend changes — reuses `POST /api/ssh/connections` verbatim.
- Scope is `SSHConnectionDialog.tsx` only; `DBConnectionDialog.tsx`'s SSH-tunnel selector is out of scope (spec's "Out of scope").
- `verbatimModuleSyntax` is on — use `import type` for all type-only imports.
- Cross-directory imports use the `@/*` alias; same-folder sibling imports use the existing `./File` convention already used throughout `src/features/*` (e.g. `WorkspaceTileArea.tsx` importing `./NewTabDialog`).
- Never edit `frontend/src/routeTree.gen.ts`.
- Run `npm run typecheck` before every commit in this plan.
- No component-test harness exists for `.tsx` files in this repo — only plain-logic `.test.ts` files run via `npx tsx` (e.g. `frontend/src/lib/ripgrepInstallPrefs.test.ts`). New pure logic gets this kind of test; new JSX wiring gets a manual browser verification step instead of a fabricated component test.

---

### Task 1: Pure jump-host draft state, validation, and request-building (`jumpHostDraft.ts`)

**Files:**
- Create: `frontend/src/features/ssh/jumpHostDraft.ts`
- Create (test): `frontend/src/features/ssh/jumpHostDraft.test.ts`

**Interfaces:**
- Produces: `interface JumpHostDraft { host: string; port: string; username: string; authType: 'password' | 'privatekey'; password: string; privateKey: string; privateKeyPath: string; passphrase: string }`
- Produces: `defaultJumpHostDraft(): JumpHostDraft`
- Produces: `isJumpHostDraftValid(draft: JumpHostDraft): boolean`
- Produces: `buildJumpHostRequest(draft: JumpHostDraft): CreateSSHConnectionBody` (from `@/lib/api`)
- Consumes: `CreateSSHConnectionBody` type from `@/lib/api` (already defined, `frontend/src/lib/api.ts:708-723`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/ssh/jumpHostDraft.test.ts`:

```ts
/**
 * Plain assertion-based tests, matching ripgrepInstallPrefs.test.ts's
 * convention (no Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/ssh/jumpHostDraft.test.ts
 */

import { buildJumpHostRequest, defaultJumpHostDraft, isJumpHostDraftValid, type JumpHostDraft } from './jumpHostDraft'

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

function passwordDraft(overrides: Partial<JumpHostDraft> = {}): JumpHostDraft {
  return { ...defaultJumpHostDraft(), host: 'bastion.example.com', username: 'deploy', password: 'hunter2', ...overrides }
}

check('defaultJumpHostDraft starts on port 22, password auth, everything else blank', () => {
  assertEqual(
    defaultJumpHostDraft(),
    { host: '', port: '22', username: '', authType: 'password', password: '', privateKey: '', privateKeyPath: '', passphrase: '' },
    'default draft shape',
  )
})

check('a fully filled-in password draft is valid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft()), true, 'valid password draft')
})

check('blank host is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ host: '  ' })), false, 'blank host')
})

check('blank username is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ username: '' })), false, 'blank username')
})

check('port 0 is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ port: '0' })), false, 'port too low')
})

check('port 65536 is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ port: '65536' })), false, 'port too high')
})

check('non-numeric port is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ port: 'abc' })), false, 'non-numeric port')
})

check('password auth with an empty password is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ password: '' })), false, 'empty password')
})

check('privatekey auth with neither key nor path is invalid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ authType: 'privatekey', password: '' })), false, 'no key material')
})

check('privatekey auth with a pasted key is valid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ authType: 'privatekey', password: '', privateKey: '-----BEGIN...' })), true, 'pasted key')
})

check('privatekey auth with only a path is valid', () => {
  assertEqual(isJumpHostDraftValid(passwordDraft({ authType: 'privatekey', password: '', privateKeyPath: '~/.ssh/id_ed25519' })), true, 'key path')
})

check('buildJumpHostRequest names the connection after the trimmed host, ungrouped, single hop', () => {
  const body = buildJumpHostRequest(passwordDraft({ host: '  bastion.example.com  ', port: '2222' }))
  assertEqual(body.name, 'bastion.example.com', 'name mirrors trimmed host')
  assertEqual(body.host, 'bastion.example.com', 'host trimmed')
  assertEqual(body.group, '', 'ungrouped')
  assertEqual(body.port, 2222, 'port parsed to a number')
  assertEqual(body.executorMachineId, null, 'no executor')
  assertEqual(body.jumpConnectionId, null, 'no chained jump of its own')
})

check('buildJumpHostRequest for password auth carries the password, not key fields', () => {
  const body = buildJumpHostRequest(passwordDraft({ password: 'hunter2' }))
  assertEqual(body.password, 'hunter2', 'password carried')
  assertEqual(body.privateKey, undefined, 'no privateKey field')
  assertEqual(body.privateKeyPath, undefined, 'no privateKeyPath field')
  assertEqual(body.passphrase, undefined, 'no passphrase field')
})

check('buildJumpHostRequest for privatekey auth carries the key and passphrase, not password', () => {
  const body = buildJumpHostRequest(
    passwordDraft({ authType: 'privatekey', password: '', privateKey: 'PEMDATA', passphrase: 'shh' }),
  )
  assertEqual(body.privateKey, 'PEMDATA', 'privateKey carried')
  assertEqual(body.passphrase, 'shh', 'passphrase carried')
  assertEqual(body.password, undefined, 'no password field')
})

check('buildJumpHostRequest prefers a pasted privateKey over privateKeyPath when both are set', () => {
  const body = buildJumpHostRequest(
    passwordDraft({ authType: 'privatekey', password: '', privateKey: 'PEMDATA', privateKeyPath: '~/.ssh/id_ed25519' }),
  )
  assertEqual(body.privateKey, 'PEMDATA', 'pasted key wins')
  assertEqual(body.privateKeyPath, undefined, 'path omitted when key present')
})

console.log(`\n${passed} tests passed`)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx tsx src/features/ssh/jumpHostDraft.test.ts`
Expected: FAIL — `Cannot find module './jumpHostDraft'` (the file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/features/ssh/jumpHostDraft.ts`:

```ts
// Pure draft state + validation for the inline "add a new jump host" mini-form
// in SSHConnectionDialog.tsx (design:
// docs/superpowers/specs/2026-07-26-ssh-jump-host-manual-add-design.md).
// Kept separate from the component so the validation/request-building logic
// is testable without a component-test harness (this repo has none for .tsx).

import type { CreateSSHConnectionBody } from '@/lib/api'

export interface JumpHostDraft {
  host: string
  port: string
  username: string
  authType: 'password' | 'privatekey'
  password: string
  privateKey: string
  privateKeyPath: string
  passphrase: string
}

export function defaultJumpHostDraft(): JumpHostDraft {
  return {
    host: '',
    port: '22',
    username: '',
    authType: 'password',
    password: '',
    privateKey: '',
    privateKeyPath: '',
    passphrase: '',
  }
}

/** Mirrors SSHConnectionDialog's own canSubmit shape (host/username/port/secret) —
 *  a jump host created here is always brand new, so there's no "isEdit" allowance. */
export function isJumpHostDraftValid(draft: JumpHostDraft): boolean {
  const port = Number.parseInt(draft.port, 10)
  const portOK = Number.isInteger(port) && port >= 1 && port <= 65535
  const secretOK = draft.authType === 'password' ? draft.password.length > 0 : Boolean(draft.privateKey || draft.privateKeyPath)
  return draft.host.trim().length > 0 && draft.username.trim().length > 0 && portOK && secretOK
}

/** Builds the create-connection request body for a manually-added jump host:
 *  name auto-set to the host (ssh_connections.name has no uniqueness constraint),
 *  ungrouped, no executor (unused by sshmgr.Dialer on intermediate hops per
 *  dialer.go:7-8) and no jump chain of its own (kept to one hop at creation). */
export function buildJumpHostRequest(draft: JumpHostDraft): CreateSSHConnectionBody {
  const body: CreateSSHConnectionBody = {
    name: draft.host.trim(),
    group: '',
    host: draft.host.trim(),
    port: Number.parseInt(draft.port, 10),
    username: draft.username.trim(),
    authType: draft.authType,
    executorMachineId: null,
    jumpConnectionId: null,
  }
  if (draft.authType === 'password') {
    body.password = draft.password
  } else if (draft.privateKey) {
    body.privateKey = draft.privateKey
  } else if (draft.privateKeyPath) {
    body.privateKeyPath = draft.privateKeyPath
  }
  if (draft.authType === 'privatekey' && draft.passphrase) {
    body.passphrase = draft.passphrase
  }
  return body
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx tsx src/features/ssh/jumpHostDraft.test.ts`
Expected: PASS — `15 tests passed` (no failures printed).

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/ssh/jumpHostDraft.ts frontend/src/features/ssh/jumpHostDraft.test.ts
git commit -m "feat(ssh): add pure jump-host draft validation and request builder"
```

---

### Task 2: Extract `SSHAuthFields` component

**Files:**
- Create: `frontend/src/features/ssh/SSHAuthFields.tsx`
- Modify: `frontend/src/features/ssh/SSHConnectionDialog.tsx:1-179` (remove the crypto helpers, `AUTH_OPTIONS`, auth-related state/handlers) and `:300-375` (replace the inline auth JSX with `<SSHAuthFields>`)

**Interfaces:**
- Produces: `interface SSHAuthFieldsValue { authType: 'password' | 'privatekey'; password: string; privateKey: string; privateKeyPath: string; passphrase: string }`
- Produces: `SSHAuthFields(props: SSHAuthFieldsValue & { onChange: (patch: Partial<SSHAuthFieldsValue>) => void; disabled?: boolean; isEdit?: boolean }): JSX.Element`
- Consumes (from `SSHConnectionDialog.tsx`'s existing state): `dialog.authType`, `dialog.password`, `dialog.privateKey`, `dialog.privateKeyPath`, `dialog.passphrase`, `setDialog`, `busy`, `isEdit` — unchanged names, just routed through the new component instead of inline JSX.

This task moves existing, already-working code — no new behavior. There is no unit-testable pure logic here (it's JSX + DOM/File/WebCrypto interaction), so verification is typecheck + a manual regression pass instead of a fabricated component test.

- [ ] **Step 1: Create `SSHAuthFields.tsx`**

```tsx
import { useRef, useState, type ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const AUTH_OPTIONS = [
  { value: 'password', label: 'Password' },
  { value: 'privatekey', label: 'Private key' },
]

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function pemBlock(label: string, buffer: ArrayBuffer) {
  const base64 = arrayBufferToBase64(buffer)
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

function base64UrlToBytes(value: string) {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function uint32Bytes(value: number) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])
}

function concatBytes(...chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function sshString(bytes: Uint8Array) {
  return concatBytes(uint32Bytes(bytes.length), bytes)
}

function sshMpint(bytes: Uint8Array) {
  const firstNonZero = bytes.findIndex((byte) => byte !== 0)
  const trimmed = firstNonZero === -1 ? new Uint8Array([0]) : bytes.slice(firstNonZero)
  return trimmed[0] & 0x80 ? concatBytes(new Uint8Array([0]), trimmed) : trimmed
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function sshRsaPublicKey(jwk: JsonWebKey) {
  if (!jwk.e || !jwk.n) throw new Error('Generated key is missing RSA parameters')
  const encoder = new TextEncoder()
  const body = concatBytes(
    sshString(encoder.encode('ssh-rsa')),
    sshString(sshMpint(base64UrlToBytes(jwk.e))),
    sshString(sshMpint(base64UrlToBytes(jwk.n))),
  )
  return `ssh-rsa ${bytesToBase64(body)} devdeck-generated`
}

export interface SSHAuthFieldsValue {
  authType: 'password' | 'privatekey'
  password: string
  privateKey: string
  privateKeyPath: string
  passphrase: string
}

interface SSHAuthFieldsProps extends SSHAuthFieldsValue {
  onChange: (patch: Partial<SSHAuthFieldsValue>) => void
  disabled?: boolean
  isEdit?: boolean
}

/** Auth-method fields (password, or private key with file-select/generate/
 *  passphrase) shared by SSHConnectionDialog's main form and its inline
 *  "add a new jump host" mini-form. */
export function SSHAuthFields({ authType, password, privateKey, privateKeyPath, passphrase, onChange, disabled, isEdit }: SSHAuthFieldsProps) {
  const showToast = useDevDeckStore((s) => s.showToast)
  const [generatedPublicKey, setGeneratedPublicKey] = useState<string | null>(null)
  const privateKeyInputRef = useRef<HTMLInputElement | null>(null)

  function selectPrivateKeyFile() {
    privateKeyInputRef.current?.click()
  }

  function handlePrivateKeyFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      onChange({ authType: 'privatekey', privateKey: text, privateKeyPath: '' })
      setGeneratedPublicKey(null)
      showToast(`Loaded private key "${file.name}"`)
      input.value = ''
    }
    reader.onerror = () => showToast('Failed to read private key')
    reader.readAsText(file)
  }

  async function generatePrivateKey() {
    try {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
      )
      const [privateDer, publicJwk] = await Promise.all([
        crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
        crypto.subtle.exportKey('jwk', keyPair.publicKey),
      ])
      onChange({ authType: 'privatekey', privateKey: pemBlock('PRIVATE KEY', privateDer), privateKeyPath: '' })
      setGeneratedPublicKey(sshRsaPublicKey(publicJwk))
      showToast('Generated SSH key — copy the public key to the host before connecting')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to generate SSH key')
    }
  }

  function copyGeneratedPublicKey() {
    if (!generatedPublicKey) return
    void navigator.clipboard.writeText(generatedPublicKey)
    showToast('Copied generated public key')
  }

  return (
    <>
      <Label>Auth</Label>
      <Select
        value={authType}
        onValueChange={(v) => onChange({ authType: v as 'password' | 'privatekey' })}
        options={AUTH_OPTIONS}
        disabled={disabled}
        aria-label="Auth method"
      />

      {authType === 'password' ? (
        <div className="mt-3">
          <Label>Password</Label>
          <Input
            value={password}
            disabled={disabled}
            type="password"
            onChange={(e) => onChange({ password: e.target.value })}
            placeholder={isEdit ? 'unchanged' : ''}
            className="mb-5 font-mono"
          />
        </div>
      ) : (
        <div className="mt-3">
          <input ref={privateKeyInputRef} type="file" className="hidden" accept=".pem,.key,.txt,*" onChange={handlePrivateKeyFile} />
          <div className="mb-2 flex items-center justify-between gap-2">
            <Label className="mb-0">Private key (PEM / ~/.ssh)</Label>
            <div className="flex items-center gap-1.5">
              <Button variant="secondary" size="sm" onClick={selectPrivateKeyFile} disabled={disabled}>
                Select key
              </Button>
              <Button variant="ghost" size="sm" onClick={generatePrivateKey} disabled={disabled}>
                Generate
              </Button>
            </div>
          </div>
          <Input
            value={privateKeyPath}
            disabled={disabled || Boolean(privateKey)}
            onChange={(e) => onChange({ privateKeyPath: e.target.value })}
            placeholder="~/.ssh/id_ed25519"
            className="mb-2.5 font-mono"
          />
          <textarea
            value={privateKey}
            disabled={disabled}
            onChange={(e) => onChange({ privateKey: e.target.value, privateKeyPath: '' })}
            placeholder={isEdit ? 'unchanged' : 'select ~/.ssh/id_ed25519, paste PEM, or generate a key'}
            rows={4}
            className="w-full resize-y rounded-lg border border-devdeck-border-strong bg-devdeck-bg px-2.5 py-2 font-mono text-[11px] text-devdeck-fg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          {generatedPublicKey ? (
            <div className="mt-2.5 rounded-lg border border-devdeck-border-strong bg-devdeck-bg p-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-devdeck-muted">Generated public key</span>
                <Button variant="ghost" size="sm" onClick={copyGeneratedPublicKey}>
                  Copy
                </Button>
              </div>
              <code className="block break-all font-mono text-[10.5px] leading-relaxed text-devdeck-fg-2">{generatedPublicKey}</code>
              <p className="mt-1.5 text-[10.5px] leading-snug text-devdeck-dim">
                Add this public key to the host's ~/.ssh/authorized_keys before connecting.
              </p>
            </div>
          ) : null}
          <Label className="mt-3">Passphrase (optional)</Label>
          <Input
            value={passphrase}
            disabled={disabled}
            type="password"
            onChange={(e) => onChange({ passphrase: e.target.value })}
            placeholder={isEdit ? 'unchanged' : ''}
            className="mb-5 font-mono"
          />
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 2: Strip the moved pieces out of `SSHConnectionDialog.tsx`**

Remove from `SSHConnectionDialog.tsx`:
- The `AUTH_OPTIONS` constant (original lines 19-22).
- The crypto helper functions `arrayBufferToBase64`, `pemBlock`, `base64UrlToBytes`, `uint32Bytes`, `concatBytes`, `sshString`, `sshMpint`, `bytesToBase64`, `sshRsaPublicKey` (original lines 27-86).
- The `generatedPublicKey` state and `privateKeyInputRef` (original lines 102-103).
- The handlers `selectPrivateKeyFile`, `handlePrivateKeyFile`, `generatePrivateKey`, `copyGeneratedPublicKey` (original lines 136-179).

Change the file's `react` import — `useRef`, `useState`, and `ChangeEvent` are only used by the pieces just removed (`privateKeyInputRef`, `generatedPublicKey`, `handlePrivateKeyFile`), so with `noUnusedLocals`/`noUnusedParameters` both `true` in `frontend/tsconfig.json`, leaving them in place fails the typecheck step below. `useMemo` stays (still used by `groupOptions`):

```ts
import { useMemo } from 'react'
```

Add the new import alongside the other same-folder-style imports:

```ts
import { SSHAuthFields } from './SSHAuthFields'
```

Replace the auth JSX block (original lines 301-375, from `<Label>Auth</Label>` through the closing of the private-key `<div>`) with:

```tsx
<SSHAuthFields
  authType={dialog.authType}
  password={dialog.password}
  privateKey={dialog.privateKey}
  privateKeyPath={dialog.privateKeyPath}
  passphrase={dialog.passphrase}
  onChange={(patch) => setDialog(patch)}
  disabled={busy}
  isEdit={isEdit}
/>
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors, no unused-import warnings. Fix any unused imports the removal left behind.

- [ ] **Step 4: Manual regression verification**

Run: `npm run dev` (or the project's existing dev-server workflow) and in the browser:
1. Open Add SSH connection. Fill Name/Host/Username, leave Auth on Password, type a password. Confirm the field renders and behaves exactly as before (this is unchanged behavior, just relocated).
2. Switch Auth to "Private key". Confirm: the "Select key" button opens a file picker and loading a `.pem`/`.key` file populates the textarea and toasts "Loaded private key...". The "Generate" button produces a key, shows the "Generated public key" block, and "Copy" copies it. The Passphrase field still renders below.
3. Save the connection, then reopen it for edit — confirm the Password/Private key placeholder shows "unchanged" as before.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/ssh/SSHAuthFields.tsx frontend/src/features/ssh/SSHConnectionDialog.tsx
git commit -m "refactor(ssh): extract SSHAuthFields from SSHConnectionDialog"
```

---

### Task 3: Inline "+ Add new jump host…" mini-form in "Connect via"

**Files:**
- Modify: `frontend/src/features/ssh/SSHConnectionDialog.tsx`

**Interfaces:**
- Consumes: `JumpHostDraft`, `defaultJumpHostDraft`, `isJumpHostDraftValid`, `buildJumpHostRequest` from `./jumpHostDraft` (Task 1); `SSHAuthFields` from `./SSHAuthFields` (Task 2); `useCreateSSHConnection` (already imported); `dialog.jumpConnectionId`, `setDialog` (already present).
- Produces: no new exports — this is the final wiring task for the feature.

- [ ] **Step 1: Add imports and the sentinel constant**

Add near the top of `SSHConnectionDialog.tsx`, alongside the existing `DIRECT`/`HUB_DECIDES` constants:

```ts
const ADD_NEW_JUMP = '__new__'
```

Change the `react` import back to include `useEffect` and `useState` (Task 2 left it as `import { useMemo } from 'react'`; this task is what needs `useState` again, for `addingJump`/`jumpDraft`):

```ts
import { useEffect, useMemo, useState } from 'react'
```

Add the remaining import (`SSHAuthFields` is already imported from Task 2 — don't duplicate it):

```ts
import { buildJumpHostRequest, defaultJumpHostDraft, isJumpHostDraftValid } from './jumpHostDraft'
```

- [ ] **Step 2: Add local state and the close-reset effect**

Inside the `SSHConnectionDialog` component, alongside the existing `useState` calls:

```ts
const [addingJump, setAddingJump] = useState(false)
const [jumpDraft, setJumpDraft] = useState(defaultJumpHostDraft())

useEffect(() => {
  if (!dialog.open) setAddingJump(false)
}, [dialog.open])
```

- [ ] **Step 3: Add the sentinel option and select/cancel/create handlers**

Modify `jumpOptions` to prepend the new option:

```ts
const jumpOptions = [
  { value: DIRECT, label: 'Direct connection' },
  { value: ADD_NEW_JUMP, label: '+ Add new jump host…' },
  ...connections.filter((c) => c.id !== dialog.editingId).map((c) => ({ value: c.id, label: c.name })),
]
```

Add handlers (near `submit()`):

```ts
function handleJumpChange(value: string) {
  if (value === ADD_NEW_JUMP) {
    setJumpDraft(defaultJumpHostDraft())
    setAddingJump(true)
    return
  }
  setAddingJump(false)
  setDialog({ jumpConnectionId: value })
}

function cancelAddJump() {
  setAddingJump(false)
}

function createJumpHost() {
  if (!isJumpHostDraftValid(jumpDraft) || busy) return
  createConnection.mutate(buildJumpHostRequest(jumpDraft), {
    onSuccess: (created) => {
      setDialog({ jumpConnectionId: created.id })
      setAddingJump(false)
      showToast(`Added jump host "${created.name}"`)
    },
    onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to add jump host'),
  })
}
```

- [ ] **Step 4: Wire the select and render the inline mini-form**

Replace the "Connect via" `<Select>` and its trailing hint paragraph (original lines 390-402: `<Label>2. Connect via</Label>` through the closing `</p>`) with:

```tsx
<Label>2. Connect via</Label>
<Select
  value={addingJump ? ADD_NEW_JUMP : dialog.jumpConnectionId}
  onValueChange={handleJumpChange}
  options={jumpOptions}
  disabled={busy}
  aria-label="Connect via"
/>
{addingJump ? (
  <div className="mt-2 rounded-lg border border-devdeck-border-strong bg-devdeck-bg p-2.5">
    <Label>Host</Label>
    <Input
      value={jumpDraft.host}
      disabled={busy}
      onChange={(e) => setJumpDraft((d) => ({ ...d, host: e.target.value }))}
      placeholder="bastion.example.com"
      className="mb-2.5 font-mono"
    />
    <div className="mb-2.5 flex gap-3">
      <div className="min-w-0 flex-1">
        <Label>Username</Label>
        <Input
          value={jumpDraft.username}
          disabled={busy}
          onChange={(e) => setJumpDraft((d) => ({ ...d, username: e.target.value }))}
          placeholder="deploy"
          className="font-mono"
        />
      </div>
      <div className="w-[90px] flex-none">
        <Label>Port</Label>
        <Input
          value={jumpDraft.port}
          disabled={busy}
          onChange={(e) => setJumpDraft((d) => ({ ...d, port: e.target.value }))}
          placeholder="22"
          className="font-mono"
        />
      </div>
    </div>
    <SSHAuthFields
      authType={jumpDraft.authType}
      password={jumpDraft.password}
      privateKey={jumpDraft.privateKey}
      privateKeyPath={jumpDraft.privateKeyPath}
      passphrase={jumpDraft.passphrase}
      onChange={(patch) => setJumpDraft((d) => ({ ...d, ...patch }))}
      disabled={busy}
    />
    <div className="flex justify-end gap-2">
      <Button variant="secondary" size="sm" onClick={cancelAddJump} disabled={busy}>
        Cancel
      </Button>
      <Button size="sm" onClick={createJumpHost} disabled={!isJumpHostDraftValid(jumpDraft) || busy}>
        Create
      </Button>
    </div>
  </div>
) : (
  <p className="mt-1.5 text-[11px] leading-snug text-devdeck-dim">
    {dialog.jumpConnectionId
      ? 'The executor dials the jump host first, then tunnels the SSH handshake through it to reach this host.'
      : 'The executor dials this host directly.'}
  </p>
)}
```

`SSHAuthFields`'s trailing margin classes (`mb-5` on its last field) already give spacing before the Cancel/Create row, matching the main form's spacing convention — no extra wrapper margin needed.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Manual verification (spec's Testing section, both scenarios)**

Run the dev server and in the browser:
1. Open Add SSH connection for a fresh host, fill Name/Host/Username/Password. In "2. Connect via", pick "+ Add new jump host…" — confirm the mini-form appears and the select shows it as selected. Fill Host/Username/Port and a password, click Create. Confirm: a toast "Added jump host "..."" appears, the mini-form collapses, "Connect via" now shows the new host's name selected, and the hint text switches to the "tunnels through it" copy.
2. Close the dialog without saving the outer connection. Go to the SSH connections list — confirm the jump host created in step 1 is present as its own entry (this is the "auto add to list" behavior — it persists independently of the outer dialog).
3. Repeat step 1 but choose "Private key" auth in the mini-form (test both the file-select and Generate paths) before clicking Create — confirm it succeeds the same way.
4. Open a different Add SSH connection, and confirm the jump host(s) created above now appear as plain selectable entries in "Connect via" (not just "+ Add new jump host…" and "Direct connection").
5. Reopen the Add SSH connection dialog after closing it once with the mini-form left open (don't click Create) — confirm the mini-form does NOT reappear on reopen (the `useEffect` reset from Step 2).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/ssh/SSHConnectionDialog.tsx
git commit -m "feat(ssh): add inline jump host creation to Connect via"
```
