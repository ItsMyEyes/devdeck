// Package hoststats measures this machine's own CPU, memory and root-disk
// usage. Its SSH counterpart (service.SSHStatsService) produces the same
// domain.HostStats from a remote /proc read, so the two are interchangeable
// to every consumer above them.
package hoststats

import (
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"

	"devdeck/backend/internal/domain"
)

// cacheTTL bounds how stale a served sample may be. It exists for
// correctness, not just cost: cpu.Percent(0, false) is delta-since-last-call,
// so two clients polling concurrently would each consume the other's window
// and report nonsense. Sharing one sample for a beat fixes that. It is well
// under the frontend's 2s poll, so it never makes the chart look frozen.
const cacheTTL = time.Second

// rootPath is the filesystem the disk figure describes. Root only — a
// multi-volume readout is explicitly out of scope.
const rootPath = "/"

// diskUsage is a seam for tests. The failure path is real — the Windows
// runtime has no "/" volume — but it cannot be provoked on a host where the
// call succeeds, and an unexercised error branch is how "0 B / 0 B with no
// explanation" survives review.
var diskUsage = disk.Usage

// Collector serves cached host samples. Safe for concurrent use.
type Collector struct {
	mu     sync.Mutex
	last   domain.HostStats
	lastAt time.Time
}

func NewCollector() *Collector { return &Collector{} }

// Collect returns a sample no older than cacheTTL.
func (c *Collector) Collect() (domain.HostStats, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	if !c.lastAt.IsZero() && now.Sub(c.lastAt) < cacheTTL {
		return c.last, nil
	}

	stats := domain.HostStats{Supported: true, SampledAt: now}

	// percpu=false gives one aggregate figure; interval 0 means "delta since
	// the previous call" rather than blocking to sample a window.
	if pcts, err := cpu.Percent(0, false); err == nil && len(pcts) > 0 {
		pct := pcts[0]
		if pct >= 0 && pct <= 100 {
			stats.CPUPct = &pct
		}
	}

	vm, err := mem.VirtualMemory()
	if err != nil {
		return domain.HostStats{}, err
	}
	stats.Mem = domain.Usage{Used: vm.Total - vm.Available, Total: vm.Total}

	// A failed disk read must not sink the whole sample — CPU and memory are
	// still worth showing. It must not vanish either: the Disk figure stays
	// zeroed, and Reason says why, so the pane explains the zeros instead of
	// asserting them.
	if du, err := diskUsage(rootPath); err == nil {
		stats.Disk = domain.Usage{Used: du.Used, Total: du.Total}
	} else {
		stats.Reason = "disk usage unavailable: " + err.Error()
	}

	c.last = stats
	c.lastAt = now
	return stats, nil
}
