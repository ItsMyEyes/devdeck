package service

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/sshmgr"
)

// statsCommand reads all three sources in one round trip. Deliberately a
// single command: a 2s poll over a high-latency link cannot afford three.
var statsCommand = []string{
	"sh", "-c",
	"cat /proc/stat; echo " + statsSectionSep + "; cat /proc/meminfo; echo " + statsSectionSep + "; df -P /",
}

// statsRunner runs the batched command for a connection and returns stdout.
// Injectable so the delta state machine is testable without a live host.
type statsRunner func(ctx context.Context, connectionID string) (string, error)

// SSHStatsService measures a saved SSH host's CPU, memory and root disk,
// producing the same domain.HostStats that hoststats produces locally.
//
// It holds the previous /proc/stat reading per connection because that file
// is cumulative: a percentage needs two samples. The first poll for a
// connection therefore reports CPUPct nil, and the chart starts one tick later.
type SSHStatsService struct {
	run statsRunner

	mu   sync.Mutex
	prev map[string]cpuSample
}

func NewSSHStatsService(pool *sshmgr.FilePool) *SSHStatsService {
	return newSSHStatsServiceWithRunner(func(ctx context.Context, connectionID string) (string, error) {
		stdout, stderr, err := sshmgr.RunCommand(ctx, pool, connectionID, statsCommand)
		if err != nil {
			if msg := strings.TrimSpace(string(stderr)); msg != "" {
				return "", fmt.Errorf("%s", msg)
			}
			return "", err
		}
		return string(stdout), nil
	})
}

func newSSHStatsServiceWithRunner(run statsRunner) *SSHStatsService {
	return &SSHStatsService{run: run, prev: map[string]cpuSample{}}
}

// Collect samples the host. A host that cannot be measured comes back as
// Supported:false with a reason rather than an error — an unmeasurable host
// is a fact to display, not a request failure. Genuine transport failures
// (unreachable, auth) still return an error for the handler to surface.
func (s *SSHStatsService) Collect(ctx context.Context, connectionID string) (domain.HostStats, error) {
	out, err := s.run(ctx, connectionID)
	if err != nil {
		return unsupportedStats(err.Error()), nil
	}

	procStat, meminfo, df, err := splitStatsOutput(out)
	if err != nil {
		return unsupportedStats("this host did not return readable /proc output — Linux only"), nil
	}
	sample, err := parseProcStat(procStat)
	if err != nil {
		return unsupportedStats("this host has no readable /proc/stat — Linux only"), nil
	}
	memUsage, err := parseMeminfo(meminfo)
	if err != nil {
		return unsupportedStats("this host has no readable /proc/meminfo — Linux only"), nil
	}

	stats := domain.HostStats{Supported: true, Mem: memUsage, SampledAt: time.Now()}
	// A df failure must not sink the sample; CPU and memory still matter.
	if diskUsage, err := parseDF(df); err == nil {
		stats.Disk = diskUsage
	}

	s.mu.Lock()
	if prev, ok := s.prev[connectionID]; ok {
		stats.CPUPct = cpuPercent(prev, sample)
	}
	s.prev[connectionID] = sample
	s.mu.Unlock()

	return stats, nil
}

// Forget drops a connection's delta state, so a reconnect starts clean.
func (s *SSHStatsService) Forget(connectionID string) {
	s.mu.Lock()
	delete(s.prev, connectionID)
	s.mu.Unlock()
}

func unsupportedStats(reason string) domain.HostStats {
	return domain.HostStats{Supported: false, Reason: reason, SampledAt: time.Now()}
}
