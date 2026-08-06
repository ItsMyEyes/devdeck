package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"devdeck/backend/internal/domain"
)

type fakeSSHStatsCollector struct {
	stats domain.HostStats
	err   error
	gotID string
}

func (f *fakeSSHStatsCollector) Collect(_ context.Context, connectionID string) (domain.HostStats, error) {
	f.gotID = connectionID
	return f.stats, f.err
}

func sshStatsRequest(id string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/ssh/connections/"+id+"/stats", nil)
	req.SetPathValue("id", id)
	return req
}

func TestSSHStatsGetReturnsTheSample(t *testing.T) {
	pct := 47.5
	svc := &fakeSSHStatsCollector{stats: domain.HostStats{
		Supported: true,
		CPUPct:    &pct,
		Mem:       domain.Usage{Used: 6_200_000_000, Total: 16_000_000_000},
		Disk:      domain.Usage{Used: 412_000_000_000, Total: 932_000_000_000},
		SampledAt: time.Now(),
	}}
	h := &SSHStatsHandler{svc: svc}
	rec := httptest.NewRecorder()

	h.Get(rec, sshStatsRequest("c1"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if svc.gotID != "c1" {
		t.Errorf("connection id = %q, want c1", svc.gotID)
	}
	var body domain.HostStats
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Supported {
		t.Errorf("supported = false, reason %q", body.Reason)
	}
	if body.CPUPct == nil || *body.CPUPct != 47.5 {
		t.Errorf("cpuPct = %v, want 47.5", body.CPUPct)
	}
	if body.Mem.Total != 16_000_000_000 || body.Disk.Total != 932_000_000_000 {
		t.Errorf("mem/disk did not survive the round trip: %+v %+v", body.Mem, body.Disk)
	}
}

// An unmeasurable host is a 200 carrying a fact, not a failure: the pane shows
// its explanatory state and stops there.
func TestSSHStatsGetReturnsUnsupportedAsA200(t *testing.T) {
	h := &SSHStatsHandler{svc: &fakeSSHStatsCollector{stats: domain.HostStats{
		Supported: false,
		Reason:    "this host has no readable /proc/stat — Linux only",
		SampledAt: time.Now(),
	}}}
	rec := httptest.NewRecorder()

	h.Get(rec, sshStatsRequest("c1"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for an unmeasurable host", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["supported"] != false {
		t.Errorf("supported = %v, want false", body["supported"])
	}
	if body["reason"] == nil || body["reason"] == "" {
		t.Error("reason is empty; the pane has nothing to show")
	}
	if _, isErrEnvelope := body["error"]; isErrEnvelope {
		t.Error("unmeasurable came back as an error envelope, not a sample")
	}
}

// A host that could not be reached is a request failure, and must arrive as
// the mandatory {"error":"message"} envelope so the pane renders its error
// state and keeps retrying — not as a calm "cannot be measured".
func TestSSHStatsGetReturnsErrorEnvelopeOnTransportFailure(t *testing.T) {
	h := &SSHStatsHandler{svc: &fakeSSHStatsCollector{
		err: errors.New("ssh: handshake failed: unable to authenticate"),
	}}
	rec := httptest.NewRecorder()

	h.Get(rec, sshStatsRequest("c1"))

	if rec.Code == http.StatusOK {
		t.Fatalf("status = 200 for an unreachable host; body = %s", rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	msg, ok := body["error"].(string)
	if !ok {
		t.Fatalf("body = %v, want the {\"error\":\"message\"} envelope", body)
	}
	if msg != "ssh: handshake failed: unable to authenticate" {
		t.Errorf("error = %q, want the transport failure surfaced", msg)
	}
	if _, leaked := body["supported"]; leaked {
		t.Error("an error response must not also carry a half-built sample")
	}
}
