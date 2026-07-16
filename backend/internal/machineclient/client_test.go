package machineclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"loom/backend/internal/domain"
)

func TestCheckHealthOnline(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	status := CheckHealth(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"})
	if status.Status != "online" {
		t.Errorf("status = %q, want online", status.Status)
	}
}

func TestCheckHealthOfflineOnUnreachable(t *testing.T) {
	status := CheckHealth(context.Background(), domain.Machine{ID: "m-1", URL: "http://127.0.0.1:1", Key: "k"})
	if status.Status != "offline" {
		t.Errorf("status = %q, want offline", status.Status)
	}
}

func TestCheckHealthOfflineOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	status := CheckHealth(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"})
	if status.Status != "offline" {
		t.Errorf("status = %q, want offline", status.Status)
	}
}

func TestProbeSucceedsWithCorrectKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/whoami" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	if err := Probe(context.Background(), srv.URL, "k"); err != nil {
		t.Errorf("Probe() error = %v, want nil", err)
	}
}

func TestProbeFailsOnUnreachable(t *testing.T) {
	err := Probe(context.Background(), "http://127.0.0.1:1", "k")
	if err == nil {
		t.Fatal("Probe() error = nil, want an unreachable error")
	}
	if !strings.Contains(err.Error(), "unreachable") {
		t.Errorf("error = %q, want it to mention unreachable", err.Error())
	}
}

func TestProbeFailsOnWrongKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)

	err := Probe(context.Background(), srv.URL, "wrong")
	if err == nil {
		t.Fatal("Probe() error = nil, want a rejected-key error")
	}
	if !strings.Contains(err.Error(), "rejected the key") {
		t.Errorf("error = %q, want it to mention the key was rejected", err.Error())
	}
}
