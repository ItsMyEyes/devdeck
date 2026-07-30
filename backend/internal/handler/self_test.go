package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"devdeck/backend/internal/selfupdate"
)

// stubSpawnReplacement replaces the package-level spawnReplacement for the
// duration of a test, returning a pointer the test can check afterward to
// see whether it was called.
func stubSpawnReplacement(t *testing.T, err error) *bool {
	t.Helper()
	called := false
	orig := spawnReplacement
	spawnReplacement = func() error {
		called = true
		return err
	}
	t.Cleanup(func() { spawnReplacement = orig })
	return &called
}

// stubExitProcess replaces the package-level exitProcess so tests never
// actually call os.Exit; the returned channel receives a value each time
// the stub runs.
func stubExitProcess(t *testing.T) <-chan struct{} {
	t.Helper()
	done := make(chan struct{}, 1)
	orig := exitProcess
	exitProcess = func() { done <- struct{}{} }
	t.Cleanup(func() { exitProcess = orig })
	return done
}

func waitForExit(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("exitProcess was not called within 1s")
	}
}

func assertExitNotCalled(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
		t.Error("exitProcess must not be called")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestPostRestartUnmanagedSpawnsReplacementThenExits(t *testing.T) {
	called := stubSpawnReplacement(t, nil)
	done := stubExitProcess(t)

	h := NewSelfHandler(false, "v0.0.0-test", false, &fakeUpdater{})
	rec := httptest.NewRecorder()
	h.PostRestart(rec, httptest.NewRequest(http.MethodPost, "/api/self/restart", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !*called {
		t.Error("PostRestart on an unmanaged process must spawn a replacement")
	}
	waitForExit(t, done)
}

func TestPostRestartManagedDoesNotSpawnReplacement(t *testing.T) {
	called := stubSpawnReplacement(t, nil)
	done := stubExitProcess(t)

	h := NewSelfHandler(true, "v0.0.0-test", false, &fakeUpdater{})
	rec := httptest.NewRecorder()
	h.PostRestart(rec, httptest.NewRequest(http.MethodPost, "/api/self/restart", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if *called {
		t.Error("PostRestart on a managed process must not spawn its own replacement")
	}
	waitForExit(t, done)
}

func TestPostRestartUnmanagedSpawnFailureReturns500AndDoesNotExit(t *testing.T) {
	stubSpawnReplacement(t, errors.New("boom"))
	done := stubExitProcess(t)

	h := NewSelfHandler(false, "v0.0.0-test", false, &fakeUpdater{})
	rec := httptest.NewRecorder()
	h.PostRestart(rec, httptest.NewRequest(http.MethodPost, "/api/self/restart", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500, body = %s", rec.Code, rec.Body.String())
	}
	assertExitNotCalled(t, done)
}

func TestPostStopUnmanagedExits(t *testing.T) {
	done := stubExitProcess(t)

	h := NewSelfHandler(false, "v0.0.0-test", false, &fakeUpdater{})
	rec := httptest.NewRecorder()
	h.PostStop(rec, httptest.NewRequest(http.MethodPost, "/api/self/stop", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	waitForExit(t, done)
}

func TestPostStopManagedRefuses(t *testing.T) {
	done := stubExitProcess(t)

	h := NewSelfHandler(true, "v0.0.0-test", false, &fakeUpdater{})
	rec := httptest.NewRecorder()
	h.PostStop(rec, httptest.NewRequest(http.MethodPost, "/api/self/stop", nil))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409, body = %s", rec.Code, rec.Body.String())
	}
	assertExitNotCalled(t, done)
}

// fakeUpdater stands in for selfupdate.Updater so these tests never reach
// GitHub or touch the running binary.
type fakeUpdater struct {
	check      *selfupdate.CheckResult
	checkErr   error
	install    *selfupdate.RunResult
	installErr error
	installed  bool
}

func (f *fakeUpdater) Check(ctx context.Context, currentVersion, selfSHA256 string) (*selfupdate.CheckResult, error) {
	if f.checkErr != nil {
		return nil, f.checkErr
	}
	return f.check, nil
}

func (f *fakeUpdater) Install(ctx context.Context, currentVersion, execPath string) (*selfupdate.RunResult, error) {
	f.installed = true
	if f.installErr != nil {
		return nil, f.installErr
	}
	return f.install, nil
}

func TestGetVersionReportsTheBuildAndItsDigest(t *testing.T) {
	h := NewSelfHandler(false, "v1.4.2", false, &fakeUpdater{})
	rec := httptest.NewRecorder()
	h.GetVersion(rec, httptest.NewRequest(http.MethodGet, "/api/self/version", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Version != "v1.4.2" {
		t.Errorf("version = %q, want v1.4.2", body.Version)
	}
	if len(body.SHA256) != 64 {
		t.Errorf("sha256 = %q, want 64 hex chars for the test binary", body.SHA256)
	}
}

func TestGetUpdateCheckReportsTheCheckResult(t *testing.T) {
	up := &fakeUpdater{check: &selfupdate.CheckResult{
		Current:          "v1.4.2",
		Latest:           "v1.5.0",
		UpdateAvailable:  true,
		ChecksumVerified: selfupdate.ChecksumVerifiedMatch,
	}}
	h := NewSelfHandler(false, "v1.4.2", true, up)
	rec := httptest.NewRecorder()
	h.GetUpdateCheck(rec, httptest.NewRequest(http.MethodGet, "/api/self/update-check", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Latest           string `json:"latest"`
		UpdateAvailable  bool   `json:"updateAvailable"`
		ChecksumVerified string `json:"checksumVerified"`
		TokenConfigured  bool   `json:"tokenConfigured"`
		Managed          bool   `json:"managed"`
		Error            string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Latest != "v1.5.0" || !body.UpdateAvailable {
		t.Errorf("body = %+v, want v1.5.0 available", body)
	}
	if body.ChecksumVerified != selfupdate.ChecksumVerifiedMatch {
		t.Errorf("checksumVerified = %q, want match", body.ChecksumVerified)
	}
	if !body.TokenConfigured {
		t.Error("tokenConfigured = false, want true")
	}
	if body.Error != "" {
		t.Errorf("error = %q, want empty", body.Error)
	}
}

func TestGetUpdateCheckReportsFailureInTheBodyNotTheStatus(t *testing.T) {
	h := NewSelfHandler(false, "dev", false, &fakeUpdater{checkErr: errors.New("running a dev build (no version tag)")})
	rec := httptest.NewRecorder()
	h.GetUpdateCheck(rec, httptest.NewRequest(http.MethodGet, "/api/self/update-check", nil))

	// 200 with an error string: one machine's broken check must not blank the
	// whole Machines page.
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 even when the check fails", rec.Code)
	}
	var body struct {
		Error           string `json:"error"`
		UpdateAvailable bool   `json:"updateAvailable"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error == "" {
		t.Error("error = empty, want the check failure reported in the body")
	}
	if body.UpdateAvailable {
		t.Error("updateAvailable = true, want false when the check failed")
	}
}

func TestPostUpdateRefusesOnAManagedProcess(t *testing.T) {
	up := &fakeUpdater{install: &selfupdate.RunResult{Updated: true, Version: "v1.5.0"}}
	h := NewSelfHandler(true, "v1.4.2", false, up)
	rec := httptest.NewRecorder()
	h.PostUpdate(rec, httptest.NewRequest(http.MethodPost, "/api/self/update", nil))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 for a supervised process", rec.Code)
	}
	if up.installed {
		t.Error("Install was called on a managed process; replacing a bundled sidecar breaks its signed bundle")
	}
	if !strings.Contains(rec.Body.String(), "desktop") {
		t.Errorf("body = %s, want it to point at the desktop installer", rec.Body.String())
	}
}

func TestPostUpdateInstallsAndReportsTheNewVersion(t *testing.T) {
	up := &fakeUpdater{install: &selfupdate.RunResult{Updated: true, Version: "v1.5.0", Warning: "no checksums"}}
	h := NewSelfHandler(false, "v1.4.2", false, up)
	rec := httptest.NewRecorder()
	h.PostUpdate(rec, httptest.NewRequest(http.MethodPost, "/api/self/update", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Status  string `json:"status"`
		Version string `json:"version"`
		Warning string `json:"warning"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "updated" || body.Version != "v1.5.0" {
		t.Errorf("body = %+v, want status updated at v1.5.0", body)
	}
	if body.Warning != "no checksums" {
		t.Errorf("warning = %q, want it forwarded to the client", body.Warning)
	}
}

func TestPostUpdateSurfacesAnInstallFailure(t *testing.T) {
	h := NewSelfHandler(false, "v1.4.2", false, &fakeUpdater{installErr: errors.New("checksum mismatch")})
	rec := httptest.NewRecorder()
	h.PostUpdate(rec, httptest.NewRequest(http.MethodPost, "/api/self/update", nil))

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502 for a failed install", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "checksum mismatch") {
		t.Errorf("body = %s, want the underlying reason", rec.Body.String())
	}
}
