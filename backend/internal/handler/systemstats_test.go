package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/hoststats"
)

func TestSystemStatsGetReturnsSupportedSample(t *testing.T) {
	h := NewSystemStatsHandler(hoststats.NewCollector())
	rec := httptest.NewRecorder()

	h.Get(rec, httptest.NewRequest(http.MethodGet, "/api/system/stats", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body domain.HostStats
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Supported {
		t.Errorf("Supported = false, reason %q", body.Reason)
	}
	if body.Mem.Total == 0 {
		t.Error("Mem.Total = 0")
	}
}

func TestSystemStatsRejectsWrongMethod(t *testing.T) {
	h := NewSystemStatsHandler(hoststats.NewCollector())
	rec := httptest.NewRecorder()

	h.Get(rec, httptest.NewRequest(http.MethodPost, "/api/system/stats", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}
