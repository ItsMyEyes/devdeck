package handler

import (
	"fmt"
	"net/http/httptest"
	"testing"

	"loom/backend/internal/service"
	"loom/backend/internal/store"
)

func TestHandleStoreErrMapsValidationTo400(t *testing.T) {
	rec := httptest.NewRecorder()
	err := fmt.Errorf("base branch %q not found: %w", "nope", service.ErrValidation)
	if !handleStoreErr(rec, err) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 400 {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandleStoreErrMapsConflictTo409(t *testing.T) {
	rec := httptest.NewRecorder()
	err := fmt.Errorf("branch %q already in use: %w", "feat/x", service.ErrConflict)
	if !handleStoreErr(rec, err) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 409 {
		t.Errorf("status = %d, want 409", rec.Code)
	}
}

func TestHandleStoreErrStillMapsNotFoundTo404(t *testing.T) {
	rec := httptest.NewRecorder()
	if !handleStoreErr(rec, store.ErrNotFound) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 404 {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}
