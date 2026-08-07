package handler

import (
	"encoding/json"
	"errors"
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
	// detect.ResolveTailscale also checks fallback dirs, the login shell's
	// PATH, and (on macOS) the Tailscale.app bundle — stripping PATH alone
	// no longer guarantees "not found" on a machine that has any of those,
	// so stub the resolver directly instead.
	orig := resolveTailscale
	resolveTailscale = func() (string, error) { return "", errors.New("not found") }
	t.Cleanup(func() { resolveTailscale = orig })

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

// fakeTailscaleWithServe branches on subcommand: "status --self --json"
// reports a logged-in tailnet, "serve status --json" reports a `tailscale
// serve` config proxying to serveTargetPort.
func fakeTailscaleWithServe(t *testing.T, serveTargetPort string) {
	t.Helper()
	writeFakeTailscale(t, `
if [ "$1" = "serve" ]; then
  echo '{"Web":{"my-mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:`+serveTargetPort+`"}}}}}'
else
  echo '{"Self":{"DNSName":"my-mac.tail1234.ts.net."}}'
fi
`)
}

func TestTailscaleStatusServeTargetMismatch(t *testing.T) {
	fakeTailscaleWithServe(t, "5173")
	h := NewTailscaleStatusHandler(true)
	h.SetPort("60635")
	resp := getTailscaleStatus(t, h)
	if resp.Ready || resp.Reason != "serve_target_mismatch" {
		t.Fatalf("got %+v, want reason=serve_target_mismatch", resp)
	}
}

func TestTailscaleStatusServeTargetMatches(t *testing.T) {
	fakeTailscaleWithServe(t, "60635")
	h := NewTailscaleStatusHandler(true)
	h.SetPort("60635")
	resp := getTailscaleStatus(t, h)
	if !resp.Ready || resp.URL != "https://my-mac.tail1234.ts.net" {
		t.Fatalf("got %+v, want ready with trimmed https URL", resp)
	}
}

func TestTailscaleStatusServeTargetUnknownIgnored(t *testing.T) {
	// "serve status --json" fails outright (e.g. older tailscale CLI) — the
	// endpoint must fall back to pre-mismatch-check behavior rather than
	// treat "can't verify" as "mismatch".
	writeFakeTailscale(t, `
if [ "$1" = "serve" ]; then
  exit 1
fi
echo '{"Self":{"DNSName":"my-mac.tail1234.ts.net."}}'
`)
	h := NewTailscaleStatusHandler(true)
	h.SetPort("60635")
	resp := getTailscaleStatus(t, h)
	if !resp.Ready || resp.URL != "https://my-mac.tail1234.ts.net" {
		t.Fatalf("got %+v, want ready despite unknown serve target", resp)
	}
}
