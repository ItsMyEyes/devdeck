package machineclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// hubMachineStub is a tiny in-memory hub machines API used by every test
// below: it starts with a fixed set of machines and records what it
// receives, so tests can assert on method/body without a real store.
type hubMachineStub struct {
	machines []hubMachine
	requests []recordedRequest
}

type recordedRequest struct {
	method string
	path   string
	body   map[string]string
}

func newHubMachineStub(initial ...hubMachine) *hubMachineStub {
	return &hubMachineStub{machines: initial}
}

func (s *hubMachineStub) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer hubk" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body map[string]string
		if r.Method == http.MethodPost || r.Method == http.MethodPatch {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		s.requests = append(s.requests, recordedRequest{method: r.Method, path: r.URL.Path, body: body})

		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(s.machines)
		case http.MethodPost:
			m := hubMachine{ID: "m-new", Name: body["name"], URL: body["url"], Key: body["key"]}
			s.machines = append(s.machines, m)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(m)
		case http.MethodPatch:
			id := r.URL.Path[len("/api/machines/"):]
			for i, m := range s.machines {
				if m.ID == id {
					if v, ok := body["name"]; ok {
						s.machines[i].Name = v
					}
					if v, ok := body["key"]; ok {
						s.machines[i].Key = v
					}
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(s.machines[i])
					return
				}
			}
			w.WriteHeader(http.StatusNotFound)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

func TestSelfRegisterCreatesWhenAbsent(t *testing.T) {
	stub := newHubMachineStub() // no existing machines
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)

	_, err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubk",
		PublicURL: "https://rt-a.tail.ts.net:8989", Name: "rt-a", Key: "rtk",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(stub.requests) != 2 || stub.requests[0].method != http.MethodGet || stub.requests[1].method != http.MethodPost {
		t.Fatalf("requests = %+v, want [GET, POST]", stub.requests)
	}
	if stub.requests[1].body["url"] != "https://rt-a.tail.ts.net:8989" || stub.requests[1].body["key"] != "rtk" {
		t.Errorf("POST body = %+v", stub.requests[1].body)
	}
}

func TestSelfRegisterPatchesWhenURLMatchesButFieldsDiffer(t *testing.T) {
	stub := newHubMachineStub(hubMachine{ID: "m-1", Name: "old-name", URL: "https://rt-a.tail.ts.net:8989", Key: "old-key"})
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)

	_, err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubk",
		PublicURL: "https://rt-a.tail.ts.net:8989", Name: "rt-a", Key: "rtk",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(stub.requests) != 2 || stub.requests[1].method != http.MethodPatch || stub.requests[1].path != "/api/machines/m-1" {
		t.Fatalf("requests = %+v, want [GET, PATCH /api/machines/m-1]", stub.requests)
	}
	if stub.machines[0].Name != "rt-a" || stub.machines[0].Key != "rtk" {
		t.Errorf("machine after patch = %+v", stub.machines[0])
	}
}

func TestSelfRegisterNoOpWhenAlreadyCorrect(t *testing.T) {
	stub := newHubMachineStub(hubMachine{ID: "m-1", Name: "rt-a", URL: "https://rt-a.tail.ts.net:8989", Key: "rtk"})
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)

	_, err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubk",
		PublicURL: "https://rt-a.tail.ts.net:8989", Name: "rt-a", Key: "rtk",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(stub.requests) != 1 || stub.requests[0].method != http.MethodGet {
		t.Fatalf("requests = %+v, want only [GET] (no-op)", stub.requests)
	}
}

func TestSelfRegisterReturnsErrorOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	_, err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubk",
		PublicURL: "https://rt-a.tail.ts.net:8989", Name: "rt-a", Key: "rtk",
	})
	if err == nil {
		t.Fatal("expected error on 500 response, got nil")
	}
}

func TestRunSelfRegisterLoopRetriesThenStopsOnSuccess(t *testing.T) {
	var mu int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu++
		if mu < 3 { // fail the first 2 requests (simulates hub not ready yet)
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			_ = json.NewEncoder(w).Encode(hubMachine{ID: "m-new"})
			return
		}
		_ = json.NewEncoder(w).Encode([]hubMachine{})
	}))
	t.Cleanup(srv.Close)

	done := make(chan struct{})
	go func() {
		RunSelfRegisterLoop(context.Background(), SelfRegisterConfig{
			HubURL: srv.URL, HubKey: "hubk",
			PublicURL: "https://rt-a.tail.ts.net:8989", Name: "rt-a", Key: "rtk",
		}, 5*time.Millisecond)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunSelfRegisterLoop did not stop after a successful registration")
	}
	if mu < 3 {
		t.Errorf("hub received %d requests, want at least 3 (2 failures + 1 success)", mu)
	}
}

func TestSelfRegisterCreateIncludesIsLocalWhenTrue(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode([]hubMachine{})
		case http.MethodPost:
			_ = json.NewDecoder(r.Body).Decode(&captured)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(hubMachine{ID: "m-new"})
		}
	}))
	t.Cleanup(srv.Close)

	_, err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubk",
		PublicURL: "http://127.0.0.1:8989", Name: "desktop", Key: "k", IsLocal: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if captured["isLocal"] != true {
		t.Errorf("POST body isLocal = %v, want true", captured["isLocal"])
	}
}

func TestSelfRegisterPatchesWhenOnlyIsLocalDiffers(t *testing.T) {
	stub := newHubMachineStub(hubMachine{ID: "m-1", Name: "rt-a", URL: "https://rt-a.tail.ts.net:8989", Key: "rtk", IsLocal: false})
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)

	_, err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubk",
		PublicURL: "https://rt-a.tail.ts.net:8989", Name: "rt-a", Key: "rtk", IsLocal: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(stub.requests) != 2 || stub.requests[1].method != http.MethodPatch {
		t.Fatalf("requests = %+v, want [GET, PATCH] (isLocal alone must trigger a patch)", stub.requests)
	}
}

func TestSelfRegisterReturnsTheHubMachineIncludingSigningKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/machines":
			_, _ = w.Write([]byte(`[]`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/machines":
			_, _ = w.Write([]byte(`{"id":"m-new","name":"builder","url":"http://runtime","key":"rt-key","isLocal":false,"signingPublicKey":"cHVia2V5"}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	got, err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubkey", PublicURL: "http://runtime", Name: "builder", Key: "rt-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "m-new" {
		t.Errorf("ID = %q, want m-new", got.ID)
	}
	if got.SigningPublicKey != "cHVia2V5" {
		t.Errorf("SigningPublicKey = %q, want cHVia2V5", got.SigningPublicKey)
	}
}
