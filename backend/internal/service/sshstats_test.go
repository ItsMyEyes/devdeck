package service

import (
	"context"
	"fmt"
	"testing"
)

func TestSSHStatsFirstSampleHasNilCPU(t *testing.T) {
	svc := newSSHStatsServiceWithRunner(func(context.Context, string) (string, error) {
		return sampleProcStat + "---\n" + sampleMeminfo + "---\n" + sampleDF, nil
	})

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
		sampleProcStat + "---\n" + sampleMeminfo + "---\n" + sampleDF,
		// sampleProcStat's first sample is prevTotal=1000, prevIdle=840 (idle
		// 800 + iowait 40, per parseProcStat/TestParseProcStat). This sample is
		// total 2000, idle+iowait 1300+0=1300 => totalDelta 1000, idleDelta 460
		// => (1000-460)/1000*100 = 54% busy against the first sample.
		"cpu  200 40 60 1300 0 0 400 0 0 0\n" + "---\n" + sampleMeminfo + "---\n" + sampleDF,
	}
	i := 0
	svc := newSSHStatsServiceWithRunner(func(context.Context, string) (string, error) {
		out := outputs[i]
		i++
		return out, nil
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
	svc := newSSHStatsServiceWithRunner(func(_ context.Context, _ string) (string, error) {
		return sampleProcStat + "---\n" + sampleMeminfo + "---\n" + sampleDF, nil
	})
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

func TestSSHStatsUnsupportedWhenNoProc(t *testing.T) {
	svc := newSSHStatsServiceWithRunner(func(context.Context, string) (string, error) {
		return "", fmt.Errorf("cat: /proc/stat: No such file or directory")
	})

	stats, err := svc.Collect(context.Background(), "conn-1")
	if err != nil {
		t.Fatalf("Collect should report unsupported, not error: %v", err)
	}
	if stats.Supported {
		t.Error("Supported = true for a host without /proc")
	}
	if stats.Reason == "" {
		t.Error("Reason is empty; the UI needs something to show")
	}
}

func TestSSHStatsUnsupportedWhenOutputUnparseable(t *testing.T) {
	svc := newSSHStatsServiceWithRunner(func(context.Context, string) (string, error) {
		return "not remotely a proc dump", nil
	})

	stats, err := svc.Collect(context.Background(), "conn-1")
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if stats.Supported {
		t.Error("Supported = true for unparseable output")
	}
}

func TestSSHStatsRebootResetsToNil(t *testing.T) {
	outputs := []string{
		"cpu  500 0 0 4500 0 0 0 0 0 0\n" + "---\n" + sampleMeminfo + "---\n" + sampleDF,
		// counters went backwards — the host rebooted
		"cpu  10 0 0 90 0 0 0 0 0 0\n" + "---\n" + sampleMeminfo + "---\n" + sampleDF,
	}
	i := 0
	svc := newSSHStatsServiceWithRunner(func(context.Context, string) (string, error) {
		out := outputs[i]
		i++
		return out, nil
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
