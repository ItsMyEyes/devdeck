package service

import "errors"

// ErrValidation indicates the caller supplied invalid input. Wrap it with
// fmt.Errorf("...: %w", ErrValidation) — handleStoreErr maps it to HTTP 400.
var ErrValidation = errors.New("validation")

// ErrConflict indicates the requested change conflicts with existing state
// (e.g. a branch already checked out by another worktree). Wrap it with
// fmt.Errorf("...: %w", ErrConflict) — handleStoreErr maps it to HTTP 409.
var ErrConflict = errors.New("conflict")
