package memoryhost

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestBareMetalEnvPairsIncludesRequiredVars(t *testing.T) {
	pairs := bareMetalEnvPairs(StartConfig{Port: 9999, LLMProvider: "anthropic", LLMAPIKey: "sk-test", LLMModel: "claude-haiku-4-5"})
	m := pairsToMap(pairs)
	if m["HINDSIGHT_API_LLM_PROVIDER"] != "anthropic" {
		t.Fatalf("provider = %q", m["HINDSIGHT_API_LLM_PROVIDER"])
	}
	if m["HINDSIGHT_API_HOST"] != "127.0.0.1" {
		t.Fatalf("host = %q, want loopback-only", m["HINDSIGHT_API_HOST"])
	}
	if m["HINDSIGHT_API_PORT"] != "9999" {
		t.Fatalf("port = %q", m["HINDSIGHT_API_PORT"])
	}
}

func TestBareMetalEnvPairsLeavesLoopbackBaseURLUnrewritten(t *testing.T) {
	pairs := bareMetalEnvPairs(StartConfig{LLMProvider: "ollama", LLMBaseURL: "http://127.0.0.1:11434"})
	m := pairsToMap(pairs)
	// Unlike container mode: a bare process shares the hub's own network
	// namespace, so the operator's own loopback address already means what
	// they intend — no host.docker.internal-style rewrite applies here.
	if got, want := m["HINDSIGHT_API_LLM_BASE_URL"], "http://127.0.0.1:11434"; got != want {
		t.Fatalf("base url = %q, want %q (unrewritten)", got, want)
	}
}

func pairsToMap(pairs []string) map[string]string {
	m := make(map[string]string, len(pairs))
	for _, p := range pairs {
		for i := 0; i < len(p); i++ {
			if p[i] == '=' {
				m[p[:i]] = p[i+1:]
				break
			}
		}
	}
	return m
}

func TestPidFileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if _, ok := readPidFile(dir); ok {
		t.Fatal("expected no pidfile initially")
	}
	if err := writePidFile(dir, 12345); err != nil {
		t.Fatalf("writePidFile: %v", err)
	}
	pid, ok := readPidFile(dir)
	if !ok || pid != 12345 {
		t.Fatalf("readPidFile = (%d, %v), want (12345, true)", pid, ok)
	}
}

func TestPidFileGarbageIsTreatedAsAbsent(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(pidFilePath(dir), []byte("not-a-pid"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := readPidFile(dir); ok {
		t.Fatal("garbage pidfile contents should not resolve to a valid pid")
	}
}

func TestBareMetalStatusReportsUnavailableWithNoPidFile(t *testing.T) {
	if _, _, err := detectBareMetal(); err != nil {
		t.Skip("neither hindsight-api nor uvx on this machine")
	}
	status := GetStatus(context.Background(), ModeBareMetal, t.TempDir())
	if !status.Available {
		t.Fatal("expected Available=true since detectBareMetal succeeded")
	}
	if status.Exists {
		t.Fatal("expected Exists=false for a fresh data dir with no pidfile")
	}
}

func TestBareMetalStopOnStalePidfileCleansUpWithoutError(t *testing.T) {
	dir := t.TempDir()
	// A PID astronomically unlikely to be alive on the test machine.
	if err := writePidFile(dir, 1<<30); err != nil {
		t.Fatal(err)
	}
	if err := (bareMetalRuntime{}).stop(context.Background(), dir); err != nil {
		t.Fatalf("stop on a stale pidfile should not error: %v", err)
	}
	if _, ok := readPidFile(dir); ok {
		t.Fatal("stale pidfile should have been removed")
	}
}

func TestBareMetalLogsReturnsEmptyStringWhenNoLogFileExists(t *testing.T) {
	out, err := (bareMetalRuntime{}).logs(context.Background(), 50, t.TempDir())
	if err != nil {
		t.Fatalf("logs: %v", err)
	}
	if out != "" {
		t.Fatalf("logs = %q, want empty for a fresh data dir", out)
	}
}

func TestBareMetalLogsReturnsOnlyTheRequestedTail(t *testing.T) {
	dir := t.TempDir()
	content := "line1\nline2\nline3\nline4\nline5\n"
	if err := os.WriteFile(logFilePath(dir), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := (bareMetalRuntime{}).logs(context.Background(), 2, dir)
	if err != nil {
		t.Fatalf("logs: %v", err)
	}
	if want := "line4\nline5"; out != want {
		t.Fatalf("logs = %q, want %q", out, want)
	}
}

// TestBareMetalStartStopStatusRoundTrip drives a REAL detached process end
// to end, using `sh`/`cmd` as a stand-in for hindsight-api — it exercises
// setDetached/processAlive/terminateGracefully/the pidfile lifecycle exactly
// as start()/stop() use them, without needing hindsight-api itself (or
// network access) installed on the test machine. This is the one test in
// this file that does not go through the bareMetalRuntime.start() entry
// point directly, since that hardcodes bareMetalPackage as the command —
// instead it duplicates just enough of start()'s spawn logic to prove the
// underlying primitives work, which is the part most likely to break
// silently (a wrong Setsid flag, a Release() that kills the child, a signal
// that doesn't reach the right process).
func TestBareMetalStartStopStatusRoundTrip(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake process is a /bin/sh script")
	}
	// status() reports on the pidfile only once it has found a bare-metal
	// runtime to report about: with neither uvx nor hindsight-api on PATH it
	// returns Status{Available: false} and never looks at the pidfile, so the
	// Exists+Running assertion below could not hold no matter how healthy the
	// fake process is. That is status()' contract, not a bug — but it makes
	// this test require a toolchain the rest of the file deliberately does
	// not, which is why CI (no uv, no hindsight-api) failed here.
	if _, _, err := detectBareMetal(); err != nil {
		t.Skipf("no uvx or hindsight-api on this machine: %v", err)
	}
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fakehindsight.sh")
	script := "#!/bin/sh\ntrap 'exit 0' TERM\nwhile true; do sleep 0.1; done\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(scriptPath)
	logFile, err := os.OpenFile(logFilePath(dir), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	setDetached(cmd)

	if err := cmd.Start(); err != nil {
		t.Fatalf("start fake process: %v", err)
	}
	pid := cmd.Process.Pid
	// Reap in the background rather than Release() — see start()'s own doc
	// comment: without this, a killed child stays a zombie and
	// syscall.Kill(pid, 0) never reports it as dead.
	go func() { _ = cmd.Wait() }()
	if err := writePidFile(dir, pid); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { terminateGracefully(pid, time.Second) })

	if !processAlive(pid) {
		t.Fatal("fake process should be alive immediately after Start")
	}
	status := (bareMetalRuntime{}).status(context.Background(), dir)
	if !status.Exists || !status.Running {
		t.Fatalf("status = %+v, want exists+running", status)
	}

	if err := (bareMetalRuntime{}).stop(context.Background(), dir); err != nil {
		t.Fatalf("stop: %v", err)
	}
	// Give the TERM trap a moment to actually exit.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && processAlive(pid) {
		time.Sleep(50 * time.Millisecond)
	}
	if processAlive(pid) {
		t.Fatal("fake process should have exited after stop()")
	}
	if _, ok := readPidFile(dir); ok {
		t.Fatal("pidfile should be removed after stop()")
	}
}
