package machineclient

import (
	"context"
	"net/http"
	"net/http/httptest"
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
