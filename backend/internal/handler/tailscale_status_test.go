package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func writeFakeTailscale(t *testing.T, script string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "tailscale")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatalf("write fake tailscale: %v", err)
	}
	t.Setenv("PATH", dir)
}

func getTailscaleStatus(t *testing.T, h *TailscaleStatusHandler) tailscaleStatusResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/tailscale-status", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp tailscaleStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp
}

func TestTailscaleStatusServeDisabled(t *testing.T) {
	h := NewTailscaleStatusHandler(false)
	resp := getTailscaleStatus(t, h)
	if resp.Ready || resp.Reason != "serve_disabled" {
		t.Fatalf("got %+v, want reason=serve_disabled", resp)
	}
}

func TestTailscaleStatusNotInstalled(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // empty dir: `tailscale` isn't on PATH
	h := NewTailscaleStatusHandler(true)
	resp := getTailscaleStatus(t, h)
	if resp.Ready || resp.Reason != "not_installed" {
		t.Fatalf("got %+v, want reason=not_installed", resp)
	}
}

func TestTailscaleStatusNotReadyOnNonZeroExit(t *testing.T) {
	writeFakeTailscale(t, "exit 1\n")
	h := NewTailscaleStatusHandler(true)
	resp := getTailscaleStatus(t, h)
	if resp.Ready || resp.Reason != "not_ready" {
		t.Fatalf("got %+v, want reason=not_ready", resp)
	}
}

func TestTailscaleStatusNotReadyOnEmptyDNSName(t *testing.T) {
	writeFakeTailscale(t, `echo '{"Self":{"DNSName":""}}'`+"\n")
	h := NewTailscaleStatusHandler(true)
	resp := getTailscaleStatus(t, h)
	if resp.Ready || resp.Reason != "not_ready" {
		t.Fatalf("got %+v, want reason=not_ready", resp)
	}
}

func TestTailscaleStatusReady(t *testing.T) {
	writeFakeTailscale(t, `echo '{"Self":{"DNSName":"my-mac.tail1234.ts.net."}}'`+"\n")
	h := NewTailscaleStatusHandler(true)
	resp := getTailscaleStatus(t, h)
	if !resp.Ready || resp.URL != "https://my-mac.tail1234.ts.net" {
		t.Fatalf("got %+v, want ready with trimmed https URL", resp)
	}
}
