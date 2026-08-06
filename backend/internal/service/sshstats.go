package service

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/sshmgr"
)

// statsCommand reads all three sources in one round trip. Deliberately a
// single command: a 2s poll over a high-latency link cannot afford three.
//
// -k pins df's block size to 1024 to match parseDF. -P alone is not enough:
// GNU df defaults to 1024 blocks *except* under POSIXLY_CORRECT, where it
// switches to 512 and every disk would be reported at exactly twice its size.
var statsCommand = []string{
	"sh", "-c",
	"cat /proc/stat; echo " + statsSectionSep + "; cat /proc/meminfo; echo " + statsSectionSep + "; df -Pk /",
}

// statsRunner runs the batched command for a connection. stdout and stderr
// come back separately, and err is reserved for *transport* failures — a host
// that could not be reached, authenticated to, or answered within the poll.
// A command that ran and exited nonzero is not an error here: it is a
// measurement result (this host has no /proc), and arrives as whatever the
// remote printed with a nil error.
//
// Injectable so the delta state machine and this split are both testable
// without a live host.
type statsRunner func(ctx context.Context, connectionID string) (stdout, stderr string, err error)

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
	return newSSHStatsServiceWithRunner(func(ctx context.Context, connectionID string) (string, string, error) {
		stdout, stderr, err := sshmgr.RunCommand(ctx, pool, connectionID, statsCommand)
		if err != nil && !ranAndFailed(err) {
			return "", "", err
		}
		return string(stdout), string(stderr), nil
	})
}

// ranAndFailed reports whether err means the remote command executed and
// exited nonzero — a `cat` that found no /proc, a `df` that could not stat / —
// as opposed to never reaching the host at all (dial, auth, host key, a
// dropped connection, a cancelled context). Only the first is a measurement;
// the second is a request failure and must reach the client as one.
func ranAndFailed(err error) bool {
	var exitErr *ssh.ExitError
	return errors.As(err, &exitErr)
}

func newSSHStatsServiceWithRunner(run statsRunner) *SSHStatsService {
	return &SSHStatsService{run: run, prev: map[string]cpuSample{}}
}

// Collect samples the host.
//
// The two failure modes are deliberately kept apart. A host that answered but
// cannot be measured — no /proc, so not Linux — comes back as Supported:false
// with a reason and a nil error: that is a fact to display, not a request
// failure, and the pane says so calmly. A host that could not be reached or
// authenticated to was never measured at all; that returns an error, so the
// handler emits the {"error":...} envelope and the pane shows its error state
// and keeps retrying on the poll interval.
func (s *SSHStatsService) Collect(ctx context.Context, connectionID string) (domain.HostStats, error) {
	out, stderr, err := s.run(ctx, connectionID)
	if err != nil {
		return domain.HostStats{}, err
	}

	procStat, meminfo, df, err := splitStatsOutput(out)
	if err != nil {
		return unsupportedStats(remoteReason(stderr, "this host did not return readable /proc output — Linux only")), nil
	}
	sample, err := parseProcStat(procStat)
	if err != nil {
		return unsupportedStats(remoteReason(stderr, "this host has no readable /proc/stat — Linux only")), nil
	}
	memUsage, err := parseMeminfo(meminfo)
	if err != nil {
		return unsupportedStats(remoteReason(stderr, "this host has no readable /proc/meminfo — Linux only")), nil
	}

	stats := domain.HostStats{Supported: true, Mem: memUsage, SampledAt: time.Now()}
	// A df failure must not sink the sample; CPU and memory still matter. It
	// must not pass silently either: an unexplained "0 B / 0 B" reads as a bug
	// in DevDeck rather than a filesystem the host would not report.
	if diskUsage, err := parseDF(df); err == nil {
		stats.Disk = diskUsage
	} else {
		stats.Reason = "disk usage unavailable: " + remoteReason(stderr, err.Error())
	}

	s.mu.Lock()
	if prev, ok := s.prev[connectionID]; ok {
		stats.CPUPct = cpuPercent(prev, sample)
	}
	s.prev[connectionID] = sample
	s.mu.Unlock()

	return stats, nil
}

// remoteReason prefers what the remote actually printed — "cat: /proc/stat: No
// such file or directory" tells an operator more than anything this process
// can invent — and falls back when the command failed silently. First line
// only: sh runs three commands and all three may have complained.
func remoteReason(stderr, fallback string) string {
	if msg, _, _ := strings.Cut(strings.TrimSpace(stderr), "\n"); msg != "" {
		return strings.TrimSpace(msg)
	}
	return fallback
}

func unsupportedStats(reason string) domain.HostStats {
	return domain.HostStats{Supported: false, Reason: reason, SampledAt: time.Now()}
}
