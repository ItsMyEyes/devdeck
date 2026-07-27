// This file holds the wizard's step machine as pure functions over an
// immutable State. It knows nothing about terminals, Bubble Tea, or the
// filesystem, which is what lets the whole flow be tested by calling Advance
// and Back directly. wizard.go is a thin rendering shell over what is here.
package setupui

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"devdeck/backend/internal/config"
)

// StepID identifies one question in the wizard.
type StepID int

// The ten steps, in the order they are asked. Which of them a given run
// actually visits depends on the role chosen in the first step — see Applies.
const (
	StepRole StepID = iota
	StepMachineName
	StepAddr
	StepDB
	StepKey
	StepPublicURL
	StepTailscale
	StepHub
	StepAuth
	StepReview
)

// AllSteps is every step in ask order.
var AllSteps = []StepID{
	StepRole, StepMachineName, StepAddr, StepDB, StepKey,
	StepPublicURL, StepTailscale, StepHub, StepAuth, StepReview,
}

// String names the step for test failures and debugging.
func (s StepID) String() string {
	switch s {
	case StepRole:
		return "role"
	case StepMachineName:
		return "machine name"
	case StepAddr:
		return "listen address"
	case StepDB:
		return "database"
	case StepKey:
		return "key"
	case StepPublicURL:
		return "public URL"
	case StepTailscale:
		return "tailscale serve"
	case StepHub:
		return "hub"
	case StepAuth:
		return "auth"
	case StepReview:
		return "review"
	}
	return "step(" + strconv.Itoa(int(s)) + ")"
}

// Built-in answers. These mirror cmd/server/main.go's flag defaults, except
// the listen address, which differs by role: a hub listens on loopback for a
// local browser, while a runtime must be reachable from the hub across the
// tailnet.
const (
	defaultHubAddr     = "127.0.0.1:8989"
	defaultRuntimeAddr = "0.0.0.0:9199"
	defaultDB          = "data/devdeck.db"
)

// Applies reports whether a step is asked for the given role.
//
// The two non-obvious exclusions: a hub has no runtime identity, so it is
// never asked for a machine name, public URL, or Tailscale setting; and a
// "both" process IS the hub, so asking it to register with another hub is
// meaningless.
func Applies(step StepID, role string) bool {
	isRuntime := role == "runtime"
	isBoth := role == "both"
	switch step {
	case StepMachineName, StepPublicURL, StepTailscale:
		return isRuntime || isBoth
	case StepHub:
		return isRuntime
	case StepAuth:
		return !isRuntime
	default:
		return true
	}
}

// State is every answer the wizard has collected plus where it is. It is
// copied by value through Advance and Back, so no transition can mutate a
// state the caller still holds.
type State struct {
	Role           string
	MachineName    string
	Addr           string
	DB             string
	Key            string
	PublicURL      string
	TailscaleServe bool
	HubURL         string
	HubKey         string
	TwoFA          bool
	SecureCookies  bool

	// Tailscale and Hub carry what the probes in probe.go found, for display
	// under the relevant fields. They never gate advancing: the spec allows
	// continuing past a failed hub check.
	Tailscale TailscaleResult
	Hub       HubResult

	// Err is the inline validation message for the current step. Non-empty
	// means the last Advance was refused.
	Err string
	// Done is set once the review step is confirmed. Only then may anything be
	// written to disk.
	Done bool
	// Aborted is set by ctrl+c. Done and Aborted are never both true.
	Aborted bool

	step StepID
}

// Step reports which question the wizard is on.
func (s State) Step() StepID { return s.step }

// at repositions the state, for tests that want to exercise one step without
// walking the whole wizard.
func (s State) at(step StepID) State {
	s.step = step
	s.Err = ""
	return s
}

// NewState builds the starting state. When existing is non-nil every answer is
// pre-filled from it — that is the reconfigure path, reached by running
// `devdeck setup` on a machine that already has a devdeck.yaml. hostname
// supplies the machine-name default when there is no config to inherit.
func NewState(existing *config.Config, hostname string) State {
	s := State{
		step:          StepRole,
		Role:          "hub",
		MachineName:   hostname,
		DB:            defaultDB,
		TwoFA:         true,
		SecureCookies: true,
	}
	if existing == nil {
		return s
	}

	s.Role = config.Pick(existing.Role, s.Role)
	s.Addr = existing.Addr
	s.DB = config.Pick(existing.DB, s.DB)
	s.Key = existing.Key
	s.MachineName = config.Pick(existing.Machine.Name, s.MachineName)
	s.PublicURL = existing.Machine.PublicURL
	s.HubURL = existing.Hub.URL
	s.HubKey = existing.Hub.Key
	// PickBool, not a bare dereference: an explicit `false` in the file must
	// survive into the wizard, which is the whole reason these are *bool.
	s.TailscaleServe = config.PickBool(existing.Tailscale.Serve, false)
	s.TwoFA = config.PickBool(existing.Auth.TwoFA, true)
	s.SecureCookies = config.PickBool(existing.Auth.SecureCookies, true)
	return s
}

// applyRoleDefaults fills in answers whose default depends on the role, once
// the role is known. An address the operator typed themselves is preserved;
// only an empty or still-default one is rewritten, so switching role on the
// way through does not silently discard a custom address.
func applyRoleDefaults(s State) State {
	want := defaultHubAddr
	if s.Role == "runtime" {
		want = defaultRuntimeAddr
	}
	switch strings.TrimSpace(s.Addr) {
	case "", defaultHubAddr, defaultRuntimeAddr:
		s.Addr = want
	}
	if strings.TrimSpace(s.DB) == "" {
		s.DB = defaultDB
	}
	return s
}

// validate returns the inline message for the current step, or "" to allow the
// advance.
func validate(s State) string {
	switch s.step {
	case StepRole:
		switch s.Role {
		case "hub", "runtime", "both":
			return ""
		default:
			return fmt.Sprintf("role must be hub, runtime, or both, not %q", s.Role)
		}

	case StepMachineName:
		if strings.TrimSpace(s.MachineName) == "" {
			return "machine name cannot be empty — the hub lists this machine by it"
		}
		if strings.ContainsAny(s.MachineName, "|\r\n") {
			return "machine name cannot contain | or a line break; it would break the connection line"
		}
		return ""

	case StepAddr:
		return validateAddr(s.Addr)

	case StepDB:
		if strings.TrimSpace(s.DB) == "" {
			return "database path cannot be empty"
		}
		return ""

	case StepKey:
		// Only runtime and both authenticate with a static key; a hub uses
		// password login, so a blank key there is a legitimate answer. This
		// mirrors main.go's own fail-fast rule.
		if (s.Role == "runtime" || s.Role == "both") && strings.TrimSpace(s.Key) == "" {
			return fmt.Sprintf("role %s needs a key — press r to generate one", s.Role)
		}
		if strings.ContainsAny(s.Key, "|\r\n") {
			return "key cannot contain | or a line break; it would break the connection line"
		}
		return ""

	case StepPublicURL:
		if strings.TrimSpace(s.PublicURL) == "" {
			return "public URL cannot be empty — the hub reaches this machine at it"
		}
		return validateAbsoluteURL(s.PublicURL, "public URL")

	case StepHub:
		// No hub URL simply means self-registration is off.
		if strings.TrimSpace(s.HubURL) == "" {
			return ""
		}
		if msg := validateAbsoluteURL(s.HubURL, "hub URL"); msg != "" {
			return msg
		}
		if strings.TrimSpace(s.HubKey) == "" {
			return "hub key is required when a hub URL is set — it authenticates this machine's registration"
		}
		return ""
	}
	return ""
}

// validateAddr rejects anything net.Listen would reject later, while the
// operator is still looking at the field.
func validateAddr(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "listen address cannot be empty"
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Sprintf("listen address %q needs a host and port, e.g. %s", addr, defaultHubAddr)
	}
	if port == "" {
		return fmt.Sprintf("listen address %q has no port", addr)
	}
	// SplitHostPort accepts a service name like "http"; net.Listen on this
	// codepath does not, so reject anything non-numeric here.
	n, err := strconv.Atoi(port)
	if err != nil || n < 0 || n > 65535 {
		return fmt.Sprintf("listen address %q has a non-numeric or out-of-range port %q", addr, port)
	}
	if host != "" {
		if ip := net.ParseIP(host); ip == nil && strings.ContainsAny(host, " \t") {
			return fmt.Sprintf("listen address host %q is not valid", host)
		}
	}
	return ""
}

// validateAbsoluteURL enforces the same shape the hub's Add machine dialog
// demands, so a URL accepted here is one the hub will also accept.
func validateAbsoluteURL(raw, label string) string {
	trimmed := strings.TrimSpace(raw)
	u, err := url.Parse(trimmed)
	if err != nil {
		return fmt.Sprintf("%s %q is not a URL — it must start with http:// or https://", label, raw)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Sprintf("%s %q must start with http:// or https://", label, raw)
	}
	if u.Host == "" {
		return fmt.Sprintf("%s %q has no host — it must start with http:// or https:// followed by a hostname", label, raw)
	}
	return ""
}

// Advance validates the current step and moves to the next one that applies to
// this role. A failed validation stays put and sets Err; confirming the review
// step sets Done.
func Advance(s State) State {
	if msg := validate(s); msg != "" {
		s.Err = msg
		return s
	}
	s.Err = ""

	if s.step == StepRole {
		s = applyRoleDefaults(s)
	}
	if s.step == StepReview {
		s.Done = true
		return s
	}

	for next := s.step + 1; int(next) < len(AllSteps); next++ {
		if Applies(next, s.Role) {
			s.step = next
			return s
		}
	}
	// Unreachable in practice: StepReview always applies.
	s.Done = true
	return s
}

// Back returns to the previous applicable step, keeping every answer and
// clearing any stale validation message. Back from the first step stays put.
func Back(s State) State {
	s.Err = ""
	for prev := s.step - 1; prev >= StepRole; prev-- {
		if Applies(prev, s.Role) {
			s.step = prev
			return s
		}
	}
	return s
}

// Abort marks the run cancelled. Done stays false, which is what guarantees
// ctrl+c leaves the filesystem untouched.
func Abort(s State) State {
	s.Aborted = true
	return s
}

// ToConfig turns the collected answers into the config that gets written.
// Fields belonging to steps this role never saw are left at their zero value,
// so a hub's devdeck.yaml carries no runtime identity and a "both" config
// carries no hub-registration target.
func ToConfig(s State) *config.Config {
	cfg := &config.Config{
		Role: s.Role,
		Addr: strings.TrimSpace(s.Addr),
		DB:   strings.TrimSpace(s.DB),
		Key:  strings.TrimSpace(s.Key),
	}

	if Applies(StepMachineName, s.Role) {
		cfg.Machine.Name = strings.TrimSpace(s.MachineName)
		cfg.Machine.PublicURL = strings.TrimSpace(s.PublicURL)
	}
	if Applies(StepTailscale, s.Role) {
		serve := s.TailscaleServe
		cfg.Tailscale.Serve = &serve
	}
	if Applies(StepHub, s.Role) && strings.TrimSpace(s.HubURL) != "" {
		cfg.Hub.URL = strings.TrimSpace(s.HubURL)
		cfg.Hub.Key = strings.TrimSpace(s.HubKey)
	}
	if Applies(StepAuth, s.Role) {
		twoFA, secure := s.TwoFA, s.SecureCookies
		cfg.Auth.TwoFA = &twoFA
		cfg.Auth.SecureCookies = &secure
	}
	// A headless runtime has no browser to open.
	if s.Role == "runtime" {
		open := false
		cfg.Open = &open
	}
	return cfg
}

// reviewRow is one label/value line on the review screen.
type reviewRow struct {
	label string
	value string
}

// reviewRows is what RenderReview prints, and is separately useful for tests
// that care about which answers a role reports rather than exact spacing.
func reviewRows(s State) []reviewRow {
	yesNo := func(b bool) string {
		if b {
			return "yes"
		}
		return "no"
	}

	rows := []reviewRow{{"role", s.Role}}
	if Applies(StepMachineName, s.Role) {
		rows = append(rows, reviewRow{"machine name", s.MachineName})
	}
	rows = append(rows,
		reviewRow{"listen address", s.Addr},
		reviewRow{"database", s.DB},
		reviewRow{"key", s.Key},
	)
	if Applies(StepPublicURL, s.Role) {
		rows = append(rows, reviewRow{"public URL", s.PublicURL})
	}
	if Applies(StepTailscale, s.Role) {
		rows = append(rows, reviewRow{"tailscale serve", yesNo(s.TailscaleServe)})
	}
	if Applies(StepHub, s.Role) && strings.TrimSpace(s.HubURL) != "" {
		rows = append(rows,
			reviewRow{"hub URL", s.HubURL},
			reviewRow{"hub key", s.HubKey},
		)
	}
	if Applies(StepAuth, s.Role) {
		rows = append(rows,
			reviewRow{"two-factor", yesNo(s.TwoFA)},
			reviewRow{"secure cookies", yesNo(s.SecureCookies)},
		)
	}
	return rows
}

// RenderReview draws the final confirmation screen. It is a plain string
// function so the exact output can be asserted without a terminal.
func RenderReview(s State) string {
	var b strings.Builder
	b.WriteString("Review\n\n")
	for _, row := range reviewRows(s) {
		fmt.Fprintf(&b, "  %-15s %s\n", row.label, row.value)
	}
	b.WriteString("\nNothing has been written yet. Press enter to write devdeck.yaml.")
	return b.String()
}
