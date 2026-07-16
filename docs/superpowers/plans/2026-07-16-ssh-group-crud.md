# SSH Group CRUD + Creatable Group Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let SSH connection groups be renamed and deleted as a unit from the sidebar, and turn the connection dialog's free-text Group field into a text input with a filtered dropdown of existing groups (still freeform — typing a new name still "creates" it, nothing changes there).

**Architecture:** No backend or domain-type changes. A "group" stays a derived value — the distinct set of non-empty `SSHConnection.group` strings. Rename/delete are implemented as bulk client-side PATCH calls (`useUpdateSSHConnection`) across every connection currently tagged with a group, reusing the existing single-connection update endpoint. A new small `Combobox` UI primitive replaces the plain `<Input>` for the group field. Rename gets its own tiny dialog (mirrors the existing `SSHConnectionDialog`/`ConfirmDeleteDialog` pattern); delete reuses the existing global `ConfirmDeleteDialog` via a new `'ssh-group'` `EditKind`.

**Tech Stack:** React 19, TypeScript (`verbatimModuleSyntax` on), zustand (`useLoomStore`), `@tanstack/react-query` (`src/features/data/queries.ts`), Tailwind v4, lucide-react icons, `@base-ui/react` Dialog primitive (already wrapped in `@/components/ui/dialog`).

## Global Constraints

- Never edit `frontend/src/routeTree.gen.ts`.
- Domain types (`frontend/src/store/types.ts` / `backend/internal/domain/models.go`) are NOT touched by this plan — `group` stays a plain `string` on `SSHConnection`.
- No backend changes at all — every task below is frontend-only.
- Use `@/*` import alias, never relative paths into `src/`.
- `import type` for type-only imports (`verbatimModuleSyntax`).
- No new frontend test framework exists (no vitest/jest configured) — verification is `npm run typecheck` (run from `frontend/`) after every task, plus a final manual browser pass.
- Design doc: `docs/superpowers/specs/2026-07-16-ssh-group-crud-design.md`.

---

### Task 1: Store plumbing — `EditKind` + rename-group state

**Files:**
- Modify: `frontend/src/store/useLoomStore.ts:27` (EditKind union)
- Modify: `frontend/src/store/useLoomStore.ts:90-109` (add `RenameSSHGroupState` interface after `SSHDialogState`)
- Modify: `frontend/src/store/useLoomStore.ts:300-306` (add renameSSHGroup fields/actions to `LoomState`)
- Modify: `frontend/src/store/useLoomStore.ts:362-377` (add initial `renameSSHGroup` value)
- Modify: `frontend/src/store/useLoomStore.ts:639-640` (add action implementations)

**Interfaces:**
- Produces: `EditKind` now includes `'ssh-group'`. New state shape `RenameSSHGroupState = { open: boolean; oldName: string; value: string }`, exposed on the store as `renameSSHGroup: RenameSSHGroupState`. New actions: `openRenameSSHGroup(group: string): void`, `closeRenameSSHGroup(): void`, `setRenameSSHGroupValue(value: string): void`.

- [ ] **Step 1: Widen `EditKind`**

In `frontend/src/store/useLoomStore.ts`, change line 27 from:

```ts
export type EditKind = 'worktree' | 'project' | 'workspace' | 'machine' | 'ssh'
```

to:

```ts
export type EditKind = 'worktree' | 'project' | 'workspace' | 'machine' | 'ssh' | 'ssh-group'
```

- [ ] **Step 2: Add `RenameSSHGroupState`**

Right after the `SSHDialogState` interface's closing brace (currently line 109, just before `export interface BrowserProxyInfo`), add:

```ts
interface RenameSSHGroupState {
  open: boolean
  oldName: string
  value: string
}
```

- [ ] **Step 3: Add state field + action signatures to `LoomState`**

Find this block (currently around line 300-306):

```ts
  // ssh dialog
  sshDialog: SSHDialogState
  openAddSSHConnection: () => void
  openEditSSHConnection: (conn: SSHConnection) => void
  closeSSHDialog: () => void
  setSSHDialog: (patch: Partial<SSHDialogState>) => void
}
```

Replace with:

```ts
  // ssh dialog
  sshDialog: SSHDialogState
  openAddSSHConnection: () => void
  openEditSSHConnection: (conn: SSHConnection) => void
  closeSSHDialog: () => void
  setSSHDialog: (patch: Partial<SSHDialogState>) => void

  // ssh group rename (delete reuses askDelete/confirmDelete with kind 'ssh-group')
  renameSSHGroup: RenameSSHGroupState
  openRenameSSHGroup: (group: string) => void
  closeRenameSSHGroup: () => void
  setRenameSSHGroupValue: (value: string) => void
}
```

- [ ] **Step 4: Add initial state**

Find the `sshDialog` initial value block (currently lines 362-377):

```ts
      sshDialog: {
        open: false,
        editingId: null,
        name: '',
        group: '',
        host: '',
        port: '22',
        username: '',
        authType: 'password',
        password: '',
        privateKey: '',
        privateKeyPath: '',
        passphrase: '',
        executorMachineId: '',
        jumpConnectionId: '',
      },
```

Add right after its closing `},`:

```ts
      renameSSHGroup: { open: false, oldName: '', value: '' },
```

- [ ] **Step 5: Add action implementations**

Find (currently lines 639-640):

```ts
      closeSSHDialog: () => set((s) => void (s.sshDialog.open = false)),
      setSSHDialog: (patch) => set((s) => void Object.assign(s.sshDialog, patch)),
```

Replace with:

```ts
      closeSSHDialog: () => set((s) => void (s.sshDialog.open = false)),
      setSSHDialog: (patch) => set((s) => void Object.assign(s.sshDialog, patch)),

      openRenameSSHGroup: (group) =>
        set((s) => void (s.renameSSHGroup = { open: true, oldName: group, value: group })),
      closeRenameSSHGroup: () => set((s) => void (s.renameSSHGroup.open = false)),
      setRenameSSHGroupValue: (value) => set((s) => void (s.renameSSHGroup.value = value)),
```

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS (no new errors — `renameSSHGroup` isn't consumed by any component yet, which is fine, unused exported store fields don't error).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/store/useLoomStore.ts
git commit -m "feat(ssh): add ssh-group EditKind and rename-group store state"
```

---

### Task 2: `Combobox` UI primitive

**Files:**
- Create: `frontend/src/components/ui/combobox.tsx`

**Interfaces:**
- Consumes: `Input` from `@/components/ui/input` (`value`, `onChange`, `disabled`, `placeholder`, `className`, plus any native input props it forwards), `cn` from `@/lib/utils`.
- Produces: `export function Combobox(props: { value: string; onChange: (value: string) => void; options: string[]; placeholder?: string; disabled?: boolean; className?: string }): JSX.Element`. `className` applies to the outer wrapper (so margin utilities like `mb-3` behave the same as they did on the old plain `<Input>`).

- [ ] **Step 1: Write the component**

Create `frontend/src/components/ui/combobox.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface ComboboxProps {
  value: string
  onChange: (value: string) => void
  options: string[]
  placeholder?: string
  disabled?: boolean
  className?: string
}

/** Freeform text input with a filtered dropdown of existing values. There's
 *  no separate "create" step — typing a value that doesn't match any option
 *  is already a valid value, same as the plain `<Input>` this replaces. The
 *  dropdown is purely for discoverability (pick an existing group instead of
 *  retyping it and risking a typo-forked duplicate). */
export function Combobox({ value, onChange, options, placeholder, disabled, className }: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => {
    const needle = value.trim().toLowerCase()
    return needle ? options.filter((o) => o.toLowerCase().includes(needle)) : options
  }, [value, options])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  function commit(next: string) {
    onChange(next)
    setOpen(false)
    setHighlighted(-1)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setHighlighted((i) => Math.min(i + 1, matches.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter') {
      if (open && highlighted >= 0 && matches[highlighted]) {
        event.preventDefault()
        commit(matches[highlighted])
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      setHighlighted(-1)
    }
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <Input
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setHighlighted(-1)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="font-mono"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && matches.length > 0 ? (
        <div
          className={cn(
            'absolute left-0 right-0 top-[calc(100%+5px)] z-[100] max-h-[220px] overflow-auto rounded-[11px]',
            'border border-loom-border-menu bg-loom-popover p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none',
          )}
        >
          {matches.map((option, index) => (
            <button
              type="button"
              key={option}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(option)}
              className={cn(
                'flex h-8 w-full cursor-pointer select-none items-center rounded-md px-2.5 text-left font-mono text-xs text-loom-fg-2 outline-none',
                index === highlighted ? 'bg-white/[0.05] text-loom-fg' : 'hover:bg-white/[0.05] hover:text-loom-fg',
              )}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS (new file, not imported anywhere yet).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ui/combobox.tsx
git commit -m "feat(ui): add Combobox — freeform input with filtered suggestions"
```

---

### Task 3: Wire `Combobox` into the SSH connection dialog's Group field

**Files:**
- Modify: `frontend/src/features/ssh/SSHConnectionDialog.tsx:1` (imports)
- Modify: `frontend/src/features/ssh/SSHConnectionDialog.tsx:81-91` (add `groupOptions`)
- Modify: `frontend/src/features/ssh/SSHConnectionDialog.tsx:226-233` (swap `Input` for `Combobox`)

**Interfaces:**
- Consumes: `Combobox` from Task 2 (`@/components/ui/combobox`), existing `useSSHConnections()` (already called in this file for `jumpOptions`).
- Produces: nothing new consumed by later tasks — this is a leaf change.

- [ ] **Step 1: Import `Combobox` and `useMemo`**

Change line 1 of `frontend/src/features/ssh/SSHConnectionDialog.tsx` from:

```tsx
import { useRef, useState, type ChangeEvent } from 'react'
```

to:

```tsx
import { useMemo, useRef, useState, type ChangeEvent } from 'react'
```

Add an import for `Combobox` next to the other `@/components/ui/*` imports (after the `Button` import, alongside `Dialog`, `Input`, etc.):

```tsx
import { Combobox } from '@/components/ui/combobox'
```

- [ ] **Step 2: Compute `groupOptions`**

In `SSHConnectionDialog()`, right after the existing:

```tsx
  const connections = useSSHConnections().data ?? []
```

add:

```tsx
  const groupOptions = useMemo(
    () => Array.from(new Set(connections.map((c) => c.group.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [connections],
  )
```

- [ ] **Step 3: Replace the Group `Input` with `Combobox`**

Change:

```tsx
      <Label>Group</Label>
      <Input
        value={dialog.group}
        disabled={busy}
        onChange={(e) => setDialog({ group: e.target.value })}
        placeholder="Production"
        className="mb-3 font-mono"
      />
```

to:

```tsx
      <Label>Group</Label>
      <Combobox
        value={dialog.group}
        onChange={(group) => setDialog({ group })}
        options={groupOptions}
        disabled={busy}
        placeholder="Production"
        className="mb-3"
      />
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/ssh/SSHConnectionDialog.tsx
git commit -m "feat(ssh): make the connection dialog's group field a Combobox"
```

---

### Task 4: `RenameSSHGroupDialog` component

**Files:**
- Create: `frontend/src/features/ssh/RenameSSHGroupDialog.tsx`
- Modify: `frontend/src/features/overlays/GlobalOverlays.tsx`

**Interfaces:**
- Consumes: `useLoomStore` fields/actions from Task 1 (`renameSSHGroup`, `setRenameSSHGroupValue`, `closeRenameSSHGroup`, `showToast`), `useSSHConnections`/`useUpdateSSHConnection` from `@/features/data/queries`.
- Produces: `export function RenameSSHGroupDialog(): JSX.Element`, mounted once in `GlobalOverlays`.

- [ ] **Step 1: Write the component**

Create `frontend/src/features/ssh/RenameSSHGroupDialog.tsx`:

```tsx
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSSHConnections, useUpdateSSHConnection } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

/** Bulk-renames every SSH connection currently tagged with `oldName` — a
 *  "group" has no id of its own (see the design spec), so renaming it means
 *  PATCHing every connection that shares the tag. */
export function RenameSSHGroupDialog() {
  const dialog = useLoomStore((s) => s.renameSSHGroup)
  const setValue = useLoomStore((s) => s.setRenameSSHGroupValue)
  const close = useLoomStore((s) => s.closeRenameSSHGroup)
  const showToast = useLoomStore((s) => s.showToast)
  const connections = useSSHConnections().data ?? []
  const updateConnection = useUpdateSSHConnection()

  const affected = useMemo(
    () => connections.filter((c) => c.group.trim() === dialog.oldName),
    [connections, dialog.oldName],
  )

  const trimmed = dialog.value.trim()
  const canSubmit = trimmed.length > 0 && trimmed !== dialog.oldName && !updateConnection.isPending

  async function submit() {
    if (!canSubmit) return
    try {
      await Promise.all(
        affected.map((connection) => updateConnection.mutateAsync({ id: connection.id, patch: { group: trimmed } })),
      )
      close()
      showToast(`Renamed group "${dialog.oldName}" to "${trimmed}"`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to rename group')
    }
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && close()} width={380}>
      <DialogTitle>Rename group</DialogTitle>
      <DialogDescription className="mb-4">
        Updates {affected.length} host{affected.length === 1 ? '' : 's'} currently tagged "{dialog.oldName}".
      </DialogDescription>
      <Label>Group name</Label>
      <Input
        value={dialog.value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder={dialog.oldName}
        className="mb-5 font-mono"
        autoFocus
      />
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={close}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {updateConnection.isPending ? 'Renaming…' : 'Rename'}
        </Button>
      </div>
    </Dialog>
  )
}
```

- [ ] **Step 2: Mount it in `GlobalOverlays`**

In `frontend/src/features/overlays/GlobalOverlays.tsx`, add the import:

```tsx
import { RenameSSHGroupDialog } from '@/features/ssh/RenameSSHGroupDialog'
```

and render it next to `SSHConnectionDialog`:

```tsx
      <MachineDialog />
      <SSHConnectionDialog />
      <RenameSSHGroupDialog />
    </>
  )
}
```

(replacing the current `<SSHConnectionDialog />\n    </>\n  )\n}` tail.)

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/ssh/RenameSSHGroupDialog.tsx frontend/src/features/overlays/GlobalOverlays.tsx
git commit -m "feat(ssh): add RenameSSHGroupDialog, mount in GlobalOverlays"
```

---

### Task 5: Hover-reveal rename/delete on the sidebar group tree

**Files:**
- Modify: `frontend/src/features/sidebar/SSHGroupTree.tsx`

**Interfaces:**
- Consumes: `openRenameSSHGroup` (Task 1), `askDelete` (existing, now accepts `'ssh-group'` per Task 1's widened `EditKind`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Import icons and new store actions**

Change:

```tsx
import { Cable, KeyRound, Plus, Server } from 'lucide-react'
```

to:

```tsx
import { Cable, KeyRound, Pencil, Plus, Server, Trash2 } from 'lucide-react'
```

In the component body, add alongside the existing `useLoomStore` selector calls:

```tsx
  const openRenameSSHGroup = useLoomStore((s) => s.openRenameSSHGroup)
  const askDelete = useLoomStore((s) => s.askDelete)
```

- [ ] **Step 2: Restructure each group row to allow trailing icon buttons**

Replace the group-row `<button>` (the one inside `{groups.map((group) => { ... })}`) — currently:

```tsx
            return (
              <button
                key={group}
                type="button"
                onClick={() => selectGroup(group)}
                aria-current={selected ? 'page' : undefined}
                className={cn(
                  'flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  selected ? 'bg-loom-hover-wash text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
                )}
              >
                {group === UNGROUPED ? (
                  <Server size={16} className="flex-none text-loom-dim" />
                ) : (
                  <KeyRound size={16} className="flex-none text-loom-dim" />
                )}
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{group}</span>
                <span className="font-mono text-[11.5px] font-semibold text-loom-dim">{count}</span>
              </button>
            )
```

with (a `<button>` can't contain nested `<button>`s, so the row becomes a `relative` wrapper `<div>` with the select-button and the icon buttons as siblings):

```tsx
            const manageable = group !== UNGROUPED
            return (
              <div key={group} className="group/row relative">
                <button
                  type="button"
                  onClick={() => selectGroup(group)}
                  aria-current={selected ? 'page' : undefined}
                  className={cn(
                    'flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    selected ? 'bg-loom-hover-wash text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
                  )}
                >
                  {group === UNGROUPED ? (
                    <Server size={16} className="flex-none text-loom-dim" />
                  ) : (
                    <KeyRound size={16} className="flex-none text-loom-dim" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{group}</span>
                  <span
                    className={cn(
                      'font-mono text-[11.5px] font-semibold text-loom-dim',
                      manageable && 'group-hover/row:hidden',
                    )}
                  >
                    {count}
                  </span>
                </button>
                {manageable ? (
                  <div className="absolute inset-y-0 right-2 hidden items-center gap-1 group-hover/row:flex">
                    <button
                      type="button"
                      aria-label={`Rename group ${group}`}
                      title="Rename group"
                      onClick={() => openRenameSSHGroup(group)}
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-loom-dim hover:bg-loom-hover-wash hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete group ${group}`}
                      title="Delete group"
                      onClick={() => askDelete('ssh-group', group, group)}
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-loom-dim hover:bg-loom-red-tint hover:text-loom-red-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ) : null}
              </div>
            )
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/sidebar/SSHGroupTree.tsx
git commit -m "feat(ssh): hover-reveal rename/delete on sidebar group rows"
```

---

### Task 6: Handle `'ssh-group'` in `ConfirmDeleteDialog`

**Files:**
- Modify: `frontend/src/features/overlays/ConfirmDeleteDialog.tsx`

**Interfaces:**
- Consumes: `useSSHConnections`, `useUpdateSSHConnection` from `@/features/data/queries`; `confirm.kind === 'ssh-group'` where `confirm.id === confirm.name === ` the group label (set by Task 5's `askDelete('ssh-group', group, group)`).
- Produces: nothing consumed elsewhere — this closes the delete-group loop.

- [ ] **Step 1: Add imports and hooks**

Change:

```tsx
import {
  useDeleteMachine,
  useDeleteProject,
  useDeleteSSHConnection,
  useDeleteWorkspace,
  useDeleteWorktree,
  useMachines,
  useWorkspaces,
} from '@/features/data/queries'
```

to:

```tsx
import {
  useDeleteMachine,
  useDeleteProject,
  useDeleteSSHConnection,
  useDeleteWorkspace,
  useDeleteWorktree,
  useMachines,
  useSSHConnections,
  useUpdateSSHConnection,
  useWorkspaces,
} from '@/features/data/queries'
```

In the component, add alongside the other hook calls (after `const deleteSSHConnection = useDeleteSSHConnection()`):

```tsx
  const sshConnections = useSSHConnections().data ?? []
  const updateSSHConnection = useUpdateSSHConnection()
```

- [ ] **Step 2: Compute the affected-hosts list once**

After the existing `const open = !!confirm` line, add:

```tsx
  const groupAffectedConnections =
    confirm?.kind === 'ssh-group' ? sshConnections.filter((c) => c.group.trim() === confirm.name) : []
```

- [ ] **Step 3: Extend `bodyFor` with a `'ssh-group'` case and a count parameter**

Change:

```tsx
function bodyFor(kind: string, name: string) {
  if (kind === 'worktree')
    return `This removes the worktree, kills its terminal session and deletes the local working copy for branch "${name}". The branch itself is kept.`
  if (kind === 'workspace')
    return `This removes workspace "${name}" and every project inside it from loom. Your files on disk are not touched.`
  if (kind === 'machine')
    return `This removes machine "${name}" from the registry. Projects still pointing at it will show as unreachable until reassigned.`
  if (kind === 'ssh')
    return `This removes SSH connection "${name}" and its stored credentials. The remote host itself is not touched.`
  return `This removes project "${name}" and all of its worktrees from loom. Your files on disk are not touched.`
}
```

to:

```tsx
function bodyFor(kind: string, name: string, groupHostCount: number) {
  if (kind === 'worktree')
    return `This removes the worktree, kills its terminal session and deletes the local working copy for branch "${name}". The branch itself is kept.`
  if (kind === 'workspace')
    return `This removes workspace "${name}" and every project inside it from loom. Your files on disk are not touched.`
  if (kind === 'machine')
    return `This removes machine "${name}" from the registry. Projects still pointing at it will show as unreachable until reassigned.`
  if (kind === 'ssh')
    return `This removes SSH connection "${name}" and its stored credentials. The remote host itself is not touched.`
  if (kind === 'ssh-group')
    return `This removes group "${name}" — ${groupHostCount} host${groupHostCount === 1 ? '' : 's'} move back to Ungrouped. The hosts themselves and their credentials are not touched.`
  return `This removes project "${name}" and all of its worktrees from loom. Your files on disk are not touched.`
}
```

And update its call site:

```tsx
        {confirm ? bodyFor(confirm.kind, confirm.name, groupAffectedConnections.length) : ''}
```

(replacing the current `{confirm ? bodyFor(confirm.kind, confirm.name) : ''}`).

- [ ] **Step 4: Add the delete branch in `onDelete`**

Find the `else if (kind === 'ssh')` branch:

```tsx
    } else if (kind === 'ssh') {
      deleteSSHConnection.mutate(id, {
        onSuccess: () => {
          cancelConfirm()
          toast()
        },
      })
    } else {
```

Add a new branch right after it, before the final `else`:

```tsx
    } else if (kind === 'ssh') {
      deleteSSHConnection.mutate(id, {
        onSuccess: () => {
          cancelConfirm()
          toast()
        },
      })
    } else if (kind === 'ssh-group') {
      Promise.all(
        groupAffectedConnections.map((c) => updateSSHConnection.mutateAsync({ id: c.id, patch: { group: '' } })),
      )
        .then(() => {
          cancelConfirm()
          showToast(`Removed group "${name}" — ${groupAffectedConnections.length} host(s) moved to Ungrouped`)
        })
        .catch((err) => showToast(err instanceof Error ? err.message : 'Failed to remove group'))
    } else {
```

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/overlays/ConfirmDeleteDialog.tsx
git commit -m "feat(ssh): bulk-clear group tag on group delete via ConfirmDeleteDialog"
```

---

### Task 7: Manual verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck + build**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: both PASS with no errors.

- [ ] **Step 2: Start the dev server and exercise the flows**

Start (or reuse) the dev server per `COMMANDS.md`, open the SSH module in a browser, and verify:
1. Sidebar "GROUPS" list: hovering a real group row reveals a pencil and trash icon; hovering "All hosts" or "Ungrouped" reveals neither.
2. Click the pencil on a group with ≥1 host → Rename dialog opens prefilled with the current name, description states the correct host count. Rename it → every host formerly in that group now shows the new group name (both in the sidebar and in the connections list).
3. Click the trash icon on a group → the existing red confirm dialog opens with "This removes group "X" — N host(s) move back to Ungrouped…". Confirm → those hosts move to "Ungrouped"; hosts and their credentials are otherwise unchanged (open one to confirm host/port/username/auth are intact).
4. Open "Add SSH connection" (or edit an existing one): the Group field now shows a dropdown of existing group names when focused/typed into, filtered as you type; clicking a suggestion fills it in; typing a brand-new name and saving still creates that group (appears in the sidebar afterward) — unchanged from before.
5. Rename a group to another existing group's name → they merge (host counts add up under the target name) — expected per the design's decision, not a bug.

- [ ] **Step 3: Fix any issues found, then final commit if changes were needed**

If Step 2 surfaces a bug, fix it in the relevant task's file, re-run `npm run typecheck`, and commit as a fixup:

```bash
git add -A
git commit -m "fix(ssh): <describe the fix>"
```
