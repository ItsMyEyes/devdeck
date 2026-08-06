package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

// fullSample is one healthy host's batched stdout.
var fullSample = sampleProcStat + "---\n" + sampleMeminfo + "---\n" + sampleDF

// okRunner returns out on every poll, as a command that ran cleanly.
func okRunner(out string) statsRunner {
	return func(context.Context, string) (string, string, error) {
		return out, "", nil
	}
}

func TestSSHStatsFirstSampleHasNilCPU(t *testing.T) {
	svc := newSSHStatsServiceWithRunner(okRunner(fullSample))

	stats, err := svc.Collect(context.Background(), "conn-1")
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if !stats.Supported {
		t.Fatalf("Supported = false: %s", stats.Reason)
	}
	if stats.CPUPct != nil {
		t.Errorf("CPUPct = %f on the first sample, want nil", *stats.CPUPct)
	}
	if stats.Mem.Total == 0 || stats.Disk.Total == 0 {
		t.Error("mem/disk should be populated even on the first sample")
	}
}

func TestSSHStatsSecondSampleComputesCPU(t *testing.T) {
	outputs := []string{
		fullSample,
		// sampleProcStat's first sample is prevTotal=1000, prevIdle=840 (idle
		// 800 + iowait 40, per parseProcStat/TestParseProcStat). This sample is
		// total 2000, idle+iowait 1300+0=1300 => totalDelta 1000, idleDelta 460
		// => (1000-460)/1000*100 = 54% busy against the first sample.
		"cpu  200 40 60 1300 0 0 400 0 0 0\n" + "---\n" + sampleMeminfo + "---\n" + sampleDF,
	}
	i := 0
	svc := newSSHStatsServiceWithRunner(func(context.Context, string) (string, string, error) {
		out := outputs[i]
		i++
		return out, "", nil
	})
	ctx := context.Background()

	if _, err := svc.Collect(ctx, "conn-1"); err != nil {
		t.Fatalf("first Collect: %v", err)
	}
	stats, err := svc.Collect(ctx, "conn-1")
	if err != nil {
		t.Fatalf("second Collect: %v", err)
	}
	if stats.CPUPct == nil {
		t.Fatal("CPUPct = nil on the second sample, want a value")
	}
	if *stats.CPUPct != 54 {
		t.Errorf("CPUPct = %f, want 54", *stats.CPUPct)
	}
}

func TestSSHStatsPerConnectionDeltaIsolation(t *testing.T) {
	svc := newSSHStatsServiceWithRunner(okRunner(fullSample))
	ctx := context.Background()

	if _, err := svc.Collect(ctx, "conn-a"); err != nil {
		t.Fatal(err)
	}
	// conn-b's first sample must still be nil — it does not inherit conn-a's.
	stats, err := svc.Collect(ctx, "conn-b")
	if err != nil {
		t.Fatal(err)
	}
	if stats.CPUPct != nil {
		t.Errorf("conn-b CPUPct = %f, want nil on its own first sample", *stats.CPUPct)
	}
}

// The two failure modes are not the same fact and must not share an outcome.
// A host that ran the command and has no /proc is a *measurement*: report it
// calmly as unsupported. A host we could not reach or authenticate to was
// never measured at all: that is a request failure, and the spec's error table
// requires the handler's error envelope so the pane shows its error state
// instead of a serene "this host cannot be measured".
func TestSSHStatsSeparatesTransportFailureFromUnmeasurableHost(t *testing.T) {
	tests := []struct {
		name           string
		stdout, stderr string
		runErr         error
		wantErr        string // substring; empty means "no error"
		wantSupported  bool
		wantReason     string // substring
	}{
		{
			name:    "auth failure",
			runErr:  errors.New("ssh: handshake failed: unable to authenticate"),
			wantErr: "unable to authenticate",
		},
		{
			name:    "connection refused",
			runErr:  errors.New("dial tcp 10.0.0.7:22: connect: connection refused"),
			wantErr: "connection refused",
		},
		{
			name:    "host key rejected",
			runErr:  errors.New("ssh: host key mismatch"),
			wantErr: "host key mismatch",
		},
		{
			name:    "poll timed out",
			runErr:  context.DeadlineExceeded,
			wantErr: context.DeadlineExceeded.Error(),
		},
		{
			// The command ran; sh printed the separators and df's output, and
			// cat complained about the missing files. Reachable, unmeasurable.
			name:       "ran but the host has no /proc",
			stdout:     "---\n---\n" + sampleDF,
			stderr:     "cat: /proc/stat: No such file or directory\ncat: /proc/meminfo: No such file or directory\n",
			wantReason: "/proc/stat: No such file or directory",
		},
		{
			name:       "ran and printed nothing usable",
			stdout:     "not remotely a proc dump",
			wantReason: "Linux only",
		},
		{
			name:          "healthy host",
			stdout:        fullSample,
			wantSupported: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := newSSHStatsServiceWithRunner(func(context.Context, string) (string, string, error) {
				return tc.stdout, tc.stderr, tc.runErr
			})

			stats, err := svc.Collect(context.Background(), "conn-1")

			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("Collect returned nil error; the handler can never surface an envelope. stats = %+v", stats)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error = %q, want it to contain %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Collect: %v", err)
			}
			if stats.Supported != tc.wantSupported {
				t.Fatalf("Supported = %v, want %v (reason %q)", stats.Supported, tc.wantSupported, stats.Reason)
			}
			if tc.wantReason != "" && !strings.Contains(stats.Reason, tc.wantReason) {
				t.Errorf("Reason = %q, want it to contain %q", stats.Reason, tc.wantReason)
			}
		})
	}
}

// A transport failure must not be laundered into the delta state either: the
// next successful poll is a first sample, not a delta against a stale one.
func TestSSHStatsTransportFailureLeavesNoSample(t *testing.T) {
	fail := true
	svc := newSSHStatsServiceWithRunner(func(context.Context, string) (string, string, error) {
		if fail {
			return "", "", errors.New("connection refused")
		}
		return fullSample, "", nil
	})
	ctx := context.Background()

	if _, err := svc.Collect(ctx, "c"); err == nil {
		t.Fatal("Collect returned nil error for a refused connection")
	}
	fail = false
	stats, err := svc.Collect(ctx, "c")
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if stats.CPUPct != nil {
		t.Errorf("CPUPct = %f, want nil: the failed poll produced no sample to delta against", *stats.CPUPct)
	}
}

// ranAndFailed is what keeps the two branches apart in production, where the
// runner is sshmgr.RunCommand rather than a closure.
func TestRanAndFailedOnlyMatchesARemoteExitStatus(t *testing.T) {
	if !ranAndFailed(&ssh.ExitError{}) {
		t.Error("a remote nonzero exit is a command that ran; want true")
	}
	if ranAndFailed(errors.New("dial tcp: connection refused")) {
		t.Error("a dial failure never ran anything; want false")
	}
	if ranAndFailed(context.DeadlineExceeded) {
		t.Error("a timed-out poll is a transport failure; want false")
	}
}

func TestSSHStatsRebootResetsToNil(t *testing.T) {
	outputs := []string{
		"cpu  500 0 0 4500 0 0 0 0 0 0\n" + "---\n" + sampleMeminfo + "---\n" + sampleDF,
		// counters went backwards — the host rebooted
		"cpu  10 0 0 90 0 0 0 0 0 0\n" + "---\n" + sampleMeminfo + "---\n" + sampleDF,
	}
	i := 0
	svc := newSSHStatsServiceWithRunner(func(context.Context, string) (string, string, error) {
		out := outputs[i]
		i++
		return out, "", nil
	})
	ctx := context.Background()

	if _, err := svc.Collect(ctx, "c"); err != nil {
		t.Fatal(err)
	}
	stats, err := svc.Collect(ctx, "c")
	if err != nil {
		t.Fatal(err)
	}
	if stats.CPUPct != nil {
		t.Errorf("CPUPct = %f after a reboot, want nil", *stats.CPUPct)
	}
}

// An unreadable df must not sink CPU and memory — but it must not render as a
// confident "0 B / 0 B" either. The spec asks for the error surfaced alongside
// the zeroed Disk.
func TestSSHStatsSurfacesDiskFailureWithoutSinkingTheSample(t *testing.T) {
	out := sampleProcStat + "---\n" + sampleMeminfo + "---\n" + "df: /: Permission denied\n"
	svc := newSSHStatsServiceWithRunner(okRunner(out))

	stats, err := svc.Collect(context.Background(), "c")
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if !stats.Supported {
		t.Fatalf("Supported = false: a bad df must not sink the sample (%s)", stats.Reason)
	}
	if stats.Mem.Total == 0 {
		t.Error("Mem.Total = 0; memory is still measurable")
	}
	if stats.Disk.Total != 0 {
		t.Errorf("Disk.Total = %d, want 0", stats.Disk.Total)
	}
	if !strings.Contains(strings.ToLower(stats.Reason), "disk") {
		t.Errorf("Reason = %q, want it to explain the empty disk figure", stats.Reason)
	}
}

// GNU df's default block size is 1024 — except under POSIXLY_CORRECT, where it
// is 512. The parser hard-codes 1024, so the command must pin it with -k
// rather than trust the remote environment; getting this wrong reports every
// disk at exactly twice its size, confidently.
func TestStatsCommandPinsDFBlockSize(t *testing.T) {
	joined := strings.Join(statsCommand, " ")
	if !strings.Contains(joined, "df -Pk /") {
		t.Errorf("statsCommand = %q, want it to run `df -Pk /`", joined)
	}
}
