package service

import "errors"

// ErrValidation indicates the caller supplied invalid input. Wrap it with
// fmt.Errorf("...: %w", ErrValidation) — handleStoreErr maps it to HTTP 400.
var ErrValidation = errors.New("validation")

// ErrConflict indicates the requested change conflicts with existing state
// (e.g. a branch already checked out by another worktree). Wrap it with
// fmt.Errorf("...: %w", ErrConflict) — handleStoreErr maps it to HTTP 409.
var ErrConflict = errors.New("conflict")

// ErrUnauthorized indicates invalid credentials or an invalid/expired
// session or pending-login token. Wrap it with fmt.Errorf("...: %w",
// ErrUnauthorized) — handleStoreErr maps it to HTTP 401.
var ErrUnauthorized = errors.New("unauthorized")

// ErrLocked indicates the account is locked out after repeated failed
// login attempts. Wrap it with fmt.Errorf("...: %w", ErrLocked) —
// handleStoreErr maps it to HTTP 423.
var ErrLocked = errors.New("locked")

// ErrForbidden indicates the request is well-formed and the credential is
// valid, but this specific action isn't allowed given the resource's current
// state (e.g. deleting a hub-synced project from a runtime). Wrap it with
// fmt.Errorf("...: %w", ErrForbidden) — handleStoreErr maps it to HTTP 403.
var ErrForbidden = errors.New("forbidden")
