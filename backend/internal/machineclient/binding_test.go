package machineclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/domain"
)

func TestPushBindingSendsHubURLAndMachineIDWithMachineKey(t *testing.T) {
	var gotAuth string
	var gotBody bindingRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.Method != http.MethodPut || r.URL.Path != "/api/runtime/binding" {
			t.Errorf("request = %s %s, want PUT /api/runtime/binding", r.Method, r.URL.Path)
		}
		json.NewDecoder(r.Body).Decode(&gotBody)
		json.NewEncoder(w).Encode(bindingResponse{Adopted: true})
	}))
	defer srv.Close()

	m := domain.Machine{ID: "m-1", URL: srv.URL, Key: "runtime-key"}
	adopted, reason, err := PushBinding(context.Background(), m, "https://hub.example.ts.net")
	if err != nil {
		t.Fatal(err)
	}
	if !adopted {
		t.Errorf("adopted = false, reason = %q, want true", reason)
	}
	if gotAuth != "Bearer runtime-key" {
		t.Errorf("Authorization = %q, want Bearer runtime-key", gotAuth)
	}
	if gotBody.HubURL != "https://hub.example.ts.net" || gotBody.MachineID != "m-1" {
		t.Errorf("body = %+v, want hubUrl=https://hub.example.ts.net machineId=m-1", gotBody)
	}
}

func TestPushBindingSurfacesRefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(bindingResponse{Adopted: false, Reason: "this runtime was launched with its own --hub-url"})
	}))
	defer srv.Close()

	m := domain.Machine{ID: "m-1", URL: srv.URL, Key: "runtime-key"}
	adopted, reason, err := PushBinding(context.Background(), m, "https://hub.example.ts.net")
	if err != nil {
		t.Fatal(err)
	}
	if adopted {
		t.Error("adopted = true, want false")
	}
	if reason == "" {
		t.Error("reason is empty, want the runtime's refusal message")
	}
}

func TestPushBindingErrorsOnUnreachableMachine(t *testing.T) {
	m := domain.Machine{ID: "m-1", URL: "http://127.0.0.1:1", Key: "k"}
	_, _, err := PushBinding(context.Background(), m, "https://hub.example.ts.net")
	if err == nil {
		t.Fatal("err = nil, want an error for an unreachable machine")
	}
}
