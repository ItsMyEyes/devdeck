package hoststats

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/disk"
)

func TestCollectReturnsPlausibleTotals(t *testing.T) {
	c := NewCollector()

	stats, err := c.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if !stats.Supported {
		t.Fatalf("Supported = false on the test host: %s", stats.Reason)
	}
	if stats.Mem.Total == 0 {
		t.Error("Mem.Total = 0; the test host must report some memory")
	}
	if stats.Mem.Used > stats.Mem.Total {
		t.Errorf("Mem.Used (%d) > Mem.Total (%d)", stats.Mem.Used, stats.Mem.Total)
	}
	if stats.Disk.Total == 0 {
		t.Error("Disk.Total = 0; the root filesystem must report some size")
	}
	if stats.SampledAt.IsZero() {
		t.Error("SampledAt is zero")
	}
}

// A root filesystem the platform will not report — most likely the Windows
// runtime, where "/" is not a volume — must not sink CPU and memory. It must
// not render as a confident "0 B / 0 B" either: an unexplained zero reads as a
// bug in DevDeck rather than as a disk that could not be measured.
func TestCollectSurfacesDiskFailureWithoutSinkingTheSample(t *testing.T) {
	orig := diskUsage
	diskUsage = func(string) (*disk.UsageStat, error) {
		return nil, errors.New("permission denied")
	}
	t.Cleanup(func() { diskUsage = orig })

	stats, err := NewCollector().Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if !stats.Supported {
		t.Fatalf("Supported = false: a bad disk read must not sink the sample (%s)", stats.Reason)
	}
	if stats.Mem.Total == 0 {
		t.Error("Mem.Total = 0; memory is still measurable")
	}
	if stats.Disk.Total != 0 || stats.Disk.Used != 0 {
		t.Errorf("Disk = %+v, want zeroed", stats.Disk)
	}
	if !strings.Contains(stats.Reason, "permission denied") {
		t.Errorf("Reason = %q, want the disk error surfaced in it", stats.Reason)
	}
}

func TestCollectCPUPctInRange(t *testing.T) {
	c := NewCollector()
	// First call primes gopsutil's internal delta window.
	if _, err := c.Collect(); err != nil {
		t.Fatalf("first Collect: %v", err)
	}
	time.Sleep(60 * time.Millisecond)

	stats, err := c.Collect()
	if err != nil {
		t.Fatalf("second Collect: %v", err)
	}
	if stats.CPUPct == nil {
		return // acceptable: no delta was available yet
	}
	if *stats.CPUPct < 0 || *stats.CPUPct > 100 {
		t.Errorf("CPUPct = %f, want 0..100", *stats.CPUPct)
	}
}

// Concurrent callers must not corrupt each other's CPU delta window.
func TestCollectIsSafeUnderConcurrency(t *testing.T) {
	c := NewCollector()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 5; j++ {
				stats, err := c.Collect()
				if err != nil {
					t.Errorf("Collect: %v", err)
					return
				}
				if stats.CPUPct != nil && (*stats.CPUPct < 0 || *stats.CPUPct > 100) {
					t.Errorf("CPUPct out of range: %f", *stats.CPUPct)
					return
				}
			}
		}()
	}
	wg.Wait()
}

func TestCollectCachesWithinTTL(t *testing.T) {
	c := NewCollector()
	first, err := c.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	second, err := c.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if !first.SampledAt.Equal(second.SampledAt) {
		t.Error("two immediate calls produced different samples; the cache is not working")
	}
}
