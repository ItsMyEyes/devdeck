package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"devdeck/backend/internal/detect"
)

// Parse only the provider's measured quota buckets; an absent fraction is not zero usage.
func parseAntigravityUsage(data []byte) ([]Window, error) {
	var report struct {
		Status  string `json:"status"`
		Command struct {
			Name string `json:"name"`
			Data struct {
				Groups []struct {
					Name    string            `json:"name"`
					Buckets []json.RawMessage `json:"buckets"`
				} `json:"groups"`
			} `json:"data"`
		} `json:"command"`
	}
	if json.Unmarshal(data, &report) != nil || !strings.EqualFold(report.Status, "SUCCESS") || report.Command.Name != "usage" {
		return nil, errors.New("invalid usage report")
	}
	windows := []Window{}
	for _, group := range report.Command.Data.Groups {
		name := strings.TrimSpace(group.Name)
		if name == "" {
			continue
		}
		for _, raw := range group.Buckets {
			var bucket struct {
				Window    string   `json:"window"`
				Remaining *float64 `json:"remaining_fraction"`
				ResetTime string   `json:"reset_time"`
			}
			if json.Unmarshal(raw, &bucket) != nil || bucket.Remaining == nil || *bucket.Remaining < 0 || *bucket.Remaining > 1 {
				continue
			}
			window := Window{Name: name, UsedPercent: math.Round((1-*bucket.Remaining)*10000) / 100}
			switch bucket.Window {
			case "5h":
				minutes := 300
				window.DurationMinutes = &minutes
			case "weekly":
				minutes := 10080
				window.DurationMinutes = &minutes
			}
			if date, err := time.Parse(time.RFC3339, bucket.ResetTime); err == nil {
				seconds := date.Unix()
				window.ResetsAt = &seconds
			}
			windows = append(windows, window)
		}
	}
	return windows, nil
}

// limitedBuffer drains the pipe even if a misbehaving CLI exceeds the limit.
type limitedBuffer struct {
	bytes.Buffer
	overflow bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := 1024*1024 - b.Len()
	if remaining < n {
		b.overflow = true
	}
	if remaining > 0 {
		_, _ = b.Buffer.Write(p[:min(n, remaining)])
	}
	return n, nil
}

var agyVersionPattern = regexp.MustCompile(`(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:$|[+\-\s])`)

func supportsAntigravityUsage(version string) bool {
	match := agyVersionPattern.FindStringSubmatch(strings.TrimSpace(version))
	if match == nil {
		return false
	}
	major, e1 := strconv.Atoi(match[1])
	minor, e2 := strconv.Atoi(match[2])
	patch, e3 := strconv.Atoi(match[3])
	return e1 == nil && e2 == nil && e3 == nil && (major > 1 || (major == 1 && (minor > 1 || (minor == 1 && patch >= 11))))
}

func runAntigravityProbe(ctx context.Context, binary string, args []string, dir string, env []string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir, cmd.Env, cmd.Stderr, cmd.WaitDelay = dir, env, io.Discard, 2*time.Second
	var output limitedBuffer
	cmd.Stdout = &output
	prepareUsageProcess(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	defer terminateUsageProcess(cmd)
	if err := cmd.Wait(); err != nil {
		return nil, err
	}
	if output.overflow {
		return nil, errors.New("usage output too large")
	}
	return output.Bytes(), nil
}

func readAntigravityUsage(ctx context.Context, binary string) ([]Window, string) {
	empty := []Window{}
	// Windows requires a browser-launch guard that also covers shell builtins.
	if runtime.GOOS == "windows" {
		return empty, "unavailable"
	}
	dir, err := os.MkdirTemp("", "devdeck-agy-usage-")
	if err != nil {
		return empty, "error"
	}
	defer os.RemoveAll(dir)
	for _, name := range []string{"open", "xdg-open"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\nexit 1\n"), 0700); err != nil {
			return empty, "error"
		}
	}
	env := detect.AugmentedEnv()
	filtered := make([]string, 0, len(env)+3)
	path := ""
	for _, e := range env {
		switch {
		case strings.HasPrefix(e, "PATH="):
			path = strings.TrimPrefix(e, "PATH=")
		case strings.HasPrefix(e, "BROWSER="), strings.HasPrefix(e, "AGY_CLI_DISABLE_AUTO_UPDATE="):
		default:
			filtered = append(filtered, e)
		}
	}
	filtered = append(filtered, "PATH="+dir+string(os.PathListSeparator)+path, "BROWSER="+filepath.Join(dir, "open"), "AGY_CLI_DISABLE_AUTO_UPDATE=true")
	versionCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	version, err := runAntigravityProbe(versionCtx, binary, []string{"--version"}, dir, filtered)
	cancel()
	if ctx.Err() != nil {
		return empty, "error"
	}
	if err != nil || !supportsAntigravityUsage(string(version)) {
		return empty, "unavailable"
	}
	output, err := runAntigravityProbe(ctx, binary, []string{"-p", "/usage", "--output-format", "json"}, dir, filtered)
	if err != nil {
		return empty, "error"
	}

	windows, err := parseAntigravityUsage(output)
	if err != nil {
		return empty, "error"
	}
	if len(windows) == 0 {
		return empty, "unavailable"
	}
	return windows, "available"
}
