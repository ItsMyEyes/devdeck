package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeRuntimeBinder struct {
	adopted    bool
	reason     string
	gotHubURL  string
	gotMachine string
	callCount  int
}

func (f *fakeRuntimeBinder) Bind(hubURL, machineID string) (bool, string) {
	f.callCount++
	f.gotHubURL, f.gotMachine = hubURL, machineID
	return f.adopted, f.reason
}

func TestPutBindingAdoptsAndReturnsResult(t *testing.T) {
	fake := &fakeRuntimeBinder{adopted: true}
	h := NewRuntimeBindingHandler(fake)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/runtime/binding",
		strings.NewReader(`{"hubUrl":"https://hub.example.ts.net","machineId":"m-abc"}`))
	h.PutBinding(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got runtimeBindingResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Adopted {
		t.Error("adopted = false, want true")
	}
	if fake.gotHubURL != "https://hub.example.ts.net" || fake.gotMachine != "m-abc" {
		t.Errorf("Bind called with (%q, %q), want (https://hub.example.ts.net, m-abc)", fake.gotHubURL, fake.gotMachine)
	}
}

func TestPutBindingReportsRefusalWithoutHTTPError(t *testing.T) {
	// A refusal (explicit --hub-url already set, or a conflicting rebind) is
	// an expected steady-state answer for the hub's push loop, not a
	// transport failure — it must come back as 200 with adopted:false so the
	// push loop can tell "reached the runtime, declined" apart from a
	// network/auth failure.
	fake := &fakeRuntimeBinder{adopted: false, reason: "this runtime was launched with its own --hub-url"}
	h := NewRuntimeBindingHandler(fake)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/runtime/binding",
		strings.NewReader(`{"hubUrl":"https://hub.example.ts.net","machineId":"m-abc"}`))
	h.PutBinding(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got runtimeBindingResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Adopted {
		t.Error("adopted = true, want false")
	}
	if got.Reason == "" {
		t.Error("reason is empty, want an explanation")
	}
}

func TestPutBindingRejectsInvalidBody(t *testing.T) {
	fake := &fakeRuntimeBinder{}
	h := NewRuntimeBindingHandler(fake)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/runtime/binding", strings.NewReader(`not json`))
	h.PutBinding(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	if fake.callCount != 0 {
		t.Errorf("Bind called %d times on invalid body, want 0", fake.callCount)
	}
}
