// Package usage reads account-level limits without exposing provider credentials.
package usage

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"

	"devdeck/backend/internal/detect"
)

type Window struct {
	Name             string  `json:"name"`
	UsedPercent      float64 `json:"usedPercent"`
	DurationMinutes  *int    `json:"durationMinutes,omitempty"`
	ResetsAt         *int64  `json:"resetsAt,omitempty"`
	ResetDescription string  `json:"resetDescription,omitempty"`
}
type Result struct {
	Provider  string    `json:"provider"`
	Status    string    `json:"status"`
	FetchedAt time.Time `json:"fetchedAt"`
	Windows   []Window  `json:"windows"`
}
type codexWindow struct {
	UsedPercent           *float64 `json:"usedPercent"`
	WindowDurationMinutes *int     `json:"windowDurationMins"`
	ResetsAt              *int64   `json:"resetsAt"`
}
type codexSnapshot struct {
	LimitName string       `json:"limitName"`
	Primary   *codexWindow `json:"primary"`
	Secondary *codexWindow `json:"secondary"`
}
type codexResponse struct {
	RateLimits          *codexSnapshot           `json:"rateLimits"`
	RateLimitsByLimitID map[string]codexSnapshot `json:"rateLimitsByLimitId"`
}

func codexWindows(r codexResponse) []Window {
	windows := []Window{}
	keys := make([]string, 0, len(r.RateLimitsByLimitID))
	for k := range r.RateLimitsByLimitID {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	add := func(name string, s codexSnapshot) {
		if s.LimitName != "" {
			name = s.LimitName
		}
		for _, w := range []*codexWindow{s.Primary, s.Secondary} {
			if w != nil && w.UsedPercent != nil && *w.UsedPercent >= 0 && *w.UsedPercent <= 100 {
				windows = append(windows, Window{Name: name, UsedPercent: *w.UsedPercent, DurationMinutes: w.WindowDurationMinutes, ResetsAt: w.ResetsAt})
			}
		}
	}
	if len(keys) > 0 {
		for _, k := range keys {
			add(k, r.RateLimitsByLimitID[k])
		}
	} else if r.RateLimits != nil {
		add("Codex", *r.RateLimits)
	}
	return windows
}

// Read invokes each provider's local CLI without returning its raw output or errors.
func Read(ctx context.Context, provider string) Result {
	result := Result{Provider: provider, Status: "unavailable", FetchedAt: time.Now().UTC(), Windows: []Window{}}
	if provider != "codex" && provider != "claude" && provider != "antigravity" {
		return result
	}
	binary, err := detect.Resolve(provider)
	if err != nil {
		result.Status = "not_installed"
		return result
	}
	timeout := 30 * time.Second
	if provider == "antigravity" {
		timeout = 90 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if provider == "antigravity" {
		result.Windows, result.Status = readAntigravityUsage(ctx, binary)
		return result
	}
	if provider == "claude" {
		windows, status := readClaudeUsage(ctx, binary)
		if status == "available" {
			result.Windows, result.Status = windows, status
			return result
		}
		if status == "error" {
			result.Status = "error"
		}
		out, err := exec.CommandContext(ctx, binary, "auth", "status", "--json").Output()
		var auth struct {
			LoggedIn *bool `json:"loggedIn"`
		}
		if json.Unmarshal(out, &auth) == nil && auth.LoggedIn != nil && !*auth.LoggedIn {
			result.Status = "not_logged_in"
		} else if err != nil {
			result.Status = "error"
		}
		return result
	}
	windows, status := readCodex(ctx, binary)
	result.Windows = windows
	result.Status = status
	return result
}

func readCodex(ctx context.Context, binary string) ([]Window, string) {
	empty := []Window{}
	cmd := exec.CommandContext(ctx, binary, "app-server")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return empty, "error"
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return empty, "error"
	}
	if err = cmd.Start(); err != nil {
		return empty, "error"
	}
	defer func() {
		_ = stdin.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()
	_, err = fmt.Fprintln(stdin, `{"id":1,"method":"initialize","params":{"clientInfo":{"name":"devdeck_usage","version":"1.0"}}}`)
	if err != nil {
		return empty, "error"
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(scanner.Bytes(), &msg) != nil {
			continue
		}
		switch string(msg.ID) {
		case "1":
			if msg.Error != nil {
				return empty, "error"
			}
			if _, err := fmt.Fprintln(stdin, `{"method":"initialized"}`+"\n"+`{"id":2,"method":"account/rateLimits/read"}`); err != nil {
				return empty, "error"
			}
		case "2":
			if msg.Error != nil {
				if strings.Contains(strings.ToLower(msg.Error.Message), "auth") || strings.Contains(strings.ToLower(msg.Error.Message), "login") {
					return empty, "not_logged_in"
				}
				return empty, "error"
			}
			var response codexResponse
			if json.Unmarshal(msg.Result, &response) != nil {
				return empty, "error"
			}
			windows := codexWindows(response)
			if len(windows) == 0 {
				return windows, "unavailable"
			}
			return windows, "available"
		}
	}
	return empty, "error"
}
