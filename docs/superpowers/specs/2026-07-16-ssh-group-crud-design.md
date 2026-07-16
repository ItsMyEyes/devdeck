# SSH connection group CRUD + creatable group field

## Problem

SSH connections have a `group` string field used purely to bucket hosts in the
sidebar (`SSHGroupTree.tsx`) and the connections list (`SSHConnectionsModule.tsx`).
There is no dedicated `Group` entity — `group` is just a column on `SSHConnection`,
and the set of "groups" shown anywhere is derived by taking the distinct
non-empty `group` values across existing connections.

Two things are missing:

1. No way to rename or delete a group as a unit — the only way to change a
   group today is editing one connection at a time.
2. The group field in `SSHConnectionDialog` is a plain text `<Input>` — typing
   a new name already "creates" a group (nothing to fix there), but there's no
   way to browse/pick an existing group, so typos silently fork groups
   (`prod` vs `Prod` vs `Production`).

## Decisions

- **Keep the derived-tag model.** No backend changes, no new table, no domain
  type changes. A group is still just the distinct set of non-empty `group`
  values across `SSHConnection` rows.
  - Create: unchanged — typing a new value in the group field and saving a
    connection creates it implicitly.
  - Read: unchanged — distinct `group` values, already computed client-side.
  - Rename: bulk-update the `group` field on every connection currently
    tagged with the old name, to the new name.
  - Delete: bulk-clear the `group` field (→ `''`) on every connection
    currently tagged with it. Connections and their credentials are
    untouched; they fall back into the synthetic "Ungrouped" bucket.
- **"Ungrouped" and "All hosts" are not real groups** — no rename/delete
  affordance for either; they're synthetic UI buckets, not values you can
  bulk-edit.
- Renaming a group to a name that already exists merges the two groups. Not
  specially handled — this is the natural result of the bulk-update.

## Changes

### 1. Group management UI — `frontend/src/features/sidebar/SSHGroupTree.tsx`

Each real group row gets hover-reveal rename (pencil, `Pencil` icon) and
delete (`Trash2` icon) buttons, styled like the existing icon buttons on
`HostCard` (`Settings2`/`Trash2`, `h-7 w-7 rounded-md` hover-background
pattern).

- **Rename**: clicking the pencil swaps the row's label for an inline text
  input (autofocused, prefilled with the current name). Enter or blur-outside
  commits; Escape cancels. On commit:
  - No-op if the trimmed value is empty or unchanged.
  - Otherwise, for every connection where `groupLabel(connection) === oldName`,
    call `useUpdateSSHConnection().mutateAsync({ id, patch: { group: newName } })`
    in parallel (`Promise.all`). Toast on completion; toast + resync (existing
    per-mutation `onError` convention) if any call fails.
- **Delete**: clicking the trash icon opens the existing global
  `ConfirmDeleteDialog` via a new `EditKind` value, `'ssh-group'` (added to
  the union in `useLoomStore.ts`). `confirmDelete.id` and `.name` both carry
  the group label (there's no separate id for a derived tag).
  - `ConfirmDeleteDialog.bodyFor` gets a `'ssh-group'` case: "This removes
    group "X" — N host(s) move back to Ungrouped. The hosts themselves and
    their credentials are not touched." (N computed from the current
    connections list at render time.)
  - `ConfirmDeleteDialog.onDelete` gets a `'ssh-group'` branch: same
    parallel-`mutateAsync` bulk update as rename, but patching `{ group: '' }`
    on every matching connection.

### 2. Creatable group field — new `frontend/src/components/ui/combobox.tsx`

A small, self-built component (not `@base-ui/react`'s `Combobox`, whose
value model is built for picking one fixed item rather than freeform text
with suggestions — not a good fit here and not worth fighting).

- Props: `value: string`, `onChange: (value: string) => void`,
  `options: string[]`, `placeholder?: string`, `disabled?: boolean`,
  `className?: string`.
- Renders a text `<Input>` plus an absolutely-positioned dropdown (opens on
  focus/typing, closes on blur/Escape/selection) listing `options` filtered
  by case-insensitive substring match against the current value. Empty
  `options` or no matches just means no dropdown.
- Keyboard: ArrowDown/ArrowUp move a highlighted index; Enter commits the
  highlighted suggestion (or does nothing special if none is highlighted —
  the typed text is already the value); Escape closes the dropdown without
  altering the text.
- Clicking a suggestion sets the value and closes the dropdown.
- Visually matches the existing `Select` popup: `rounded-[11px] border
  border-loom-border-menu bg-loom-popover` popup, same shadow/transition
  classes, same item row height/hover treatment.

`SSHConnectionDialog.tsx`: replace the plain `<Input>` for the Group field
with this `Combobox`, sourcing `options` from the distinct non-empty
`connection.group` values already available via `useSSHConnections()` in
that component.

## Out of scope

- No backend/domain changes (`backend/internal/domain/models.go`,
  `port/store.go` untouched).
- No unrelated visual fixes elsewhere in the SSH pages — design effort is
  scoped to making the above affordances look native.
- No color/ordering/metadata on groups — still just a name.
