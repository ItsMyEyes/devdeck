package service

import (
	"fmt"
	"strconv"
	"strings"

	"devdeck/backend/internal/domain"
)

// statsSectionSep separates the three payloads in the single batched command
// SSHStatsService runs. One round trip matters: this polls every 2s over a
// link that may be transcontinental.
const statsSectionSep = "---"

// cpuSample is one cumulative /proc/stat reading. Both fields are jiffies
// since boot, so a percentage needs two samples and the delta between them.
type cpuSample struct {
	total uint64
	idle  uint64
}

// parseProcStat reads the aggregate "cpu " line. Idle counts idle+iowait:
// a CPU waiting on disk is not doing work, and treating iowait as busy makes
// an I/O-bound host look pegged.
func parseProcStat(text string) (cpuSample, error) {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "cpu" {
			continue
		}
		// user nice system idle iowait irq softirq [steal guest guest_nice]
		if len(fields) < 8 {
			return cpuSample{}, fmt.Errorf("/proc/stat cpu line has %d fields, want at least 8", len(fields)-1)
		}
		var sample cpuSample
		for i, raw := range fields[1:] {
			v, err := strconv.ParseUint(raw, 10, 64)
			if err != nil {
				return cpuSample{}, fmt.Errorf("/proc/stat field %d: %w", i, err)
			}
			sample.total += v
			if i == 3 || i == 4 { // idle, iowait
				sample.idle += v
			}
		}
		return sample, nil
	}
	return cpuSample{}, fmt.Errorf("/proc/stat has no aggregate cpu line")
}

// cpuPercent returns busy percentage between two samples, or nil when the
// delta is unusable: no elapsed jiffies, or counters that went backwards
// (the host rebooted between polls). nil means "unknown" — reporting 0 there
// would read as "idle", which is a different and wrong claim.
func cpuPercent(prev, cur cpuSample) *float64 {
	if cur.total <= prev.total || cur.idle < prev.idle {
		return nil
	}
	totalDelta := float64(cur.total - prev.total)
	idleDelta := float64(cur.idle - prev.idle)
	if idleDelta > totalDelta {
		return nil
	}
	pct := (totalDelta - idleDelta) / totalDelta * 100
	return &pct
}

// parseMeminfo converts /proc/meminfo (kB units) to bytes. MemAvailable is
// the kernel's own estimate of what a new workload could claim and is the
// right "free" figure; the Free+Buffers+Cached fallback covers kernels older
// than 3.14 that do not publish it.
func parseMeminfo(text string) (domain.Usage, error) {
	vals := map[string]uint64{}
	for _, line := range strings.Split(text, "\n") {
		key, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		vals[key] = v * 1024 // every /proc/meminfo value is in kB
	}

	total, ok := vals["MemTotal"]
	if !ok || total == 0 {
		return domain.Usage{}, fmt.Errorf("/proc/meminfo has no MemTotal")
	}
	if available, ok := vals["MemAvailable"]; ok {
		return domain.Usage{Used: total - available, Total: total}, nil
	}
	free := vals["MemFree"] + vals["Buffers"] + vals["Cached"]
	if free > total {
		free = total
	}
	return domain.Usage{Used: total - free, Total: total}, nil
}

// parseDF reads `df -P /` output. -P forces POSIX single-line records, so a
// long device name cannot wrap and shift the columns.
func parseDF(text string) (domain.Usage, error) {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) < 2 {
		return domain.Usage{}, fmt.Errorf("df output has no data row")
	}
	// Filesystem 1024-blocks Used Available Capacity Mounted-on
	fields := strings.Fields(lines[len(lines)-1])
	if len(fields) < 4 {
		return domain.Usage{}, fmt.Errorf("df data row has %d fields, want at least 4", len(fields))
	}
	const blockSize = 1024
	total, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return domain.Usage{}, fmt.Errorf("df total blocks: %w", err)
	}
	used, err := strconv.ParseUint(fields[2], 10, 64)
	if err != nil {
		return domain.Usage{}, fmt.Errorf("df used blocks: %w", err)
	}
	return domain.Usage{Used: used * blockSize, Total: total * blockSize}, nil
}

// splitStatsOutput cuts the batched command's stdout into its three payloads.
func splitStatsOutput(out string) (procStat, meminfo, df string, err error) {
	parts := strings.Split(out, statsSectionSep)
	if len(parts) != 3 {
		return "", "", "", fmt.Errorf("stats output has %d sections, want 3", len(parts))
	}
	return parts[0], parts[1], parts[2], nil
}
