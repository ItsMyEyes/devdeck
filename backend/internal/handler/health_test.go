package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWhoamiReportsRoleAndKeepsStatus(t *testing.T) {
	h := NewWhoamiHandler("runtime", "builder")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))

	var got map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	// status must survive: machineclient.Probe checks only for a 200, but
	// older clients read this field.
	if got["status"] != "ok" {
		t.Errorf("status = %q, want ok", got["status"])
	}
	if got["role"] != "runtime" {
		t.Errorf("role = %q, want runtime", got["role"])
	}
	if got["machineName"] != "builder" {
		t.Errorf("machineName = %q, want builder", got["machineName"])
	}
}
