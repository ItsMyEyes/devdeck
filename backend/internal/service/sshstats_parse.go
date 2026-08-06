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

// Column offsets within the aggregate "cpu " line, after the leading label.
const (
	colUser = iota
	colNice
	_ // system
	colIdle
	colIOWait
	_ // irq
	_ // softirq
	_ // steal
	colGuest
	colGuestNice
)

// minCPUColumns is user through softirq. steal, guest and guest_nice arrived
// in later kernels and are read only when present.
const minCPUColumns = 7

// parseProcStat reads the aggregate "cpu " line. Idle counts idle+iowait:
// a CPU waiting on disk is not doing work, and treating iowait as busy makes
// an I/O-bound host look pegged.
//
// Guest time is subtracted back out of user and nice before summing. The
// kernel's account_guest_time folds guest into user and guest_nice into nice
// *and* publishes both in their own columns, so a naive sum of all ten counts
// that time twice — inflating total while idle stands still, which drags a
// hypervisor's busy% toward 100 (a box at a true 50% reads as 67%). procps and
// htop do the same subtraction.
func parseProcStat(text string) (cpuSample, error) {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "cpu" {
			continue
		}
		// user nice system idle iowait irq softirq [steal guest guest_nice]
		values := fields[1:]
		if len(values) < minCPUColumns {
			return cpuSample{}, fmt.Errorf("/proc/stat cpu line has %d fields, want at least %d", len(values), minCPUColumns)
		}
		cols := make([]uint64, len(values))
		for i, raw := range values {
			v, err := strconv.ParseUint(raw, 10, 64)
			if err != nil {
				return cpuSample{}, fmt.Errorf("/proc/stat field %d: %w", i, err)
			}
			cols[i] = v
		}
		if len(cols) > colGuest {
			cols[colUser] = subFloor(cols[colUser], cols[colGuest])
		}
		if len(cols) > colGuestNice {
			cols[colNice] = subFloor(cols[colNice], cols[colGuestNice])
		}

		var sample cpuSample
		for i, v := range cols {
			sample.total += v
			if i == colIdle || i == colIOWait {
				sample.idle += v
			}
		}
		return sample, nil
	}
	return cpuSample{}, fmt.Errorf("/proc/stat has no aggregate cpu line")
}

// subFloor subtracts without wrapping. guest can only exceed user on a kernel
// that is lying to us; 0 is the honest answer there, not 1.8e19.
func subFloor(a, b uint64) uint64 {
	if b > a {
		return 0
	}
	return a - b
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
	// Both branches clamp: a container's synthesised /proc/meminfo (lxcfs) can
	// report more available than total, and an unclamped subtraction wraps
	// uint64 into "16.0 EB used".
	if available, ok := vals["MemAvailable"]; ok {
		return domain.Usage{Used: subFloor(total, available), Total: total}, nil
	}
	free := vals["MemFree"] + vals["Buffers"] + vals["Cached"]
	return domain.Usage{Used: subFloor(total, free), Total: total}, nil
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
//
// Bounded at three parts, not split on every occurrence: the separator is a
// bare "---" and df's Filesystem column is arbitrary remote text — LVM doubles
// the hyphens in device-mapper names, so an ordinary root on a VG named "vg-"
// prints "/dev/mapper/vg---root". df is the last section, so stopping the
// split there puts every such occurrence harmlessly inside the df payload
// instead of shattering the whole sample into "unsupported".
func splitStatsOutput(out string) (procStat, meminfo, df string, err error) {
	parts := strings.SplitN(out, statsSectionSep, 3)
	if len(parts) != 3 {
		return "", "", "", fmt.Errorf("stats output has %d sections, want 3", len(parts))
	}
	return parts[0], parts[1], parts[2], nil
}
