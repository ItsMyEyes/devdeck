package setupui

import (
	"strings"
	"testing"

	"devdeck/backend/internal/config"
)

// walk drives the pure step machine from the first step to Done, answering
// every step with whatever the state already holds. It returns the steps that
// were actually visited, which is what the per-role tests assert on.
func walk(t *testing.T, s State) ([]StepID, State) {
	t.Helper()
	var visited []StepID
	for i := 0; !s.Done && !s.Aborted; i++ {
		if i > len(AllSteps)+2 {
			t.Fatalf("step machine did not terminate; visited %v", visited)
		}
		visited = append(visited, s.Step())
		next := Advance(s)
		if next.Err != "" {
			t.Fatalf("unexpected validation error on step %v: %s", s.Step(), next.Err)
		}
		s = next
	}
	return visited, s
}

func hubState() State {
	s := NewState(nil, "myhost")
	s.Role = "hub"
	s = applyRoleDefaults(s)
	s.Key = "hubkey"
	return s
}

func runtimeState() State {
	s := NewState(nil, "builder")
	s.Role = "runtime"
	s = applyRoleDefaults(s)
	s.Key = "rtkey"
	s.PublicURL = "https://builder.tail-abc.ts.net"
	s.HubURL = "https://hq.tail-abc.ts.net"
	s.HubKey = "hubkey"
	return s
}

func bothState() State {
	s := runtimeState()
	s.Role = "both"
	s = applyRoleDefaults(s)
	return s
}

func TestStepsVisitedPerRole(t *testing.T) {
	tests := []struct {
		name    string
		state   State
		want    []StepID
		skipped []StepID
	}{
		{
			name:    "hub skips the runtime identity steps",
			state:   hubState(),
			want:    []StepID{StepRole, StepAddr, StepDB, StepKey, StepAuth, StepReview},
			skipped: []StepID{StepMachineName, StepPublicURL, StepTailscale, StepHub},
		},
		{
			name:    "runtime skips the hub-only auth step",
			state:   runtimeState(),
			want:    []StepID{StepRole, StepMachineName, StepAddr, StepDB, StepKey, StepPublicURL, StepTailscale, StepHub, StepReview},
			skipped: []StepID{StepAuth},
		},
		{
			name:    "both visits everything except the hub registration step",
			state:   bothState(),
			want:    []StepID{StepRole, StepMachineName, StepAddr, StepDB, StepKey, StepPublicURL, StepTailscale, StepAuth, StepReview},
			skipped: []StepID{StepHub},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			visited, end := walk(t, tt.state)
			if !end.Done {
				t.Fatalf("walk ended without Done: %+v", end)
			}
			if len(visited) != len(tt.want) {
				t.Fatalf("visited %v, want %v", visited, tt.want)
			}
			for i := range tt.want {
				if visited[i] != tt.want[i] {
					t.Fatalf("visited %v, want %v", visited, tt.want)
				}
			}
			for _, skipped := range tt.skipped {
				for _, got := range visited {
					if got == skipped {
						t.Errorf("step %v should not appear for role %q", skipped, tt.state.Role)
					}
				}
			}
		})
	}
}

// A "both" machine is its own hub, so asking it to register with another hub
// is meaningless — that is why StepHub is runtime-only.
func TestBothRoleSkipsHubRegistration(t *testing.T) {
	if Applies(StepHub, "both") {
		t.Error("StepHub applies to role both, but a both process IS the hub")
	}
	if !Applies(StepHub, "runtime") {
		t.Error("StepHub must apply to role runtime")
	}
}

func TestValidationBlocksAdvance(t *testing.T) {
	tests := []struct {
		name    string
		state   func() State
		wantErr string
	}{
		{
			name:    "unknown role",
			state:   func() State { s := NewState(nil, "h"); s.Role = "leader"; return s },
			wantErr: "role",
		},
		{
			name: "listen address without a port",
			state: func() State {
				s := hubState()
				s = s.at(StepAddr)
				s.Addr = "127.0.0.1"
				return s
			},
			wantErr: "address",
		},
		{
			name: "listen address with a non-numeric port",
			state: func() State {
				s := hubState()
				s = s.at(StepAddr)
				s.Addr = "127.0.0.1:http"
				return s
			},
			wantErr: "address",
		},
		{
			name: "empty database path",
			state: func() State {
				s := hubState()
				s = s.at(StepDB)
				s.DB = "  "
				return s
			},
			wantErr: "database",
		},
		{
			name: "runtime with no key",
			state: func() State {
				s := runtimeState()
				s = s.at(StepKey)
				s.Key = ""
				return s
			},
			wantErr: "key",
		},
		{
			name: "both with no key",
			state: func() State {
				s := bothState()
				s = s.at(StepKey)
				s.Key = ""
				return s
			},
			wantErr: "key",
		},
		{
			name: "empty machine name",
			state: func() State {
				s := runtimeState()
				s = s.at(StepMachineName)
				s.MachineName = ""
				return s
			},
			wantErr: "name",
		},
		{
			name: "public url that is not absolute",
			state: func() State {
				s := runtimeState()
				s = s.at(StepPublicURL)
				s.PublicURL = "builder.local"
				return s
			},
			wantErr: "http",
		},
		{
			name: "malformed hub url",
			state: func() State {
				s := runtimeState()
				s = s.at(StepHub)
				s.HubURL = "not a url"
				return s
			},
			wantErr: "http",
		},
		{
			name: "hub url without a hub key",
			state: func() State {
				s := runtimeState()
				s = s.at(StepHub)
				s.HubKey = ""
				return s
			},
			wantErr: "key",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := tt.state()
			after := Advance(before)
			if after.Err == "" {
				t.Fatalf("Advance succeeded, want a validation error")
			}
			if !strings.Contains(strings.ToLower(after.Err), tt.wantErr) {
				t.Errorf("error %q does not mention %q", after.Err, tt.wantErr)
			}
			if after.Step() != before.Step() {
				t.Errorf("advanced to %v despite the error; must stay on %v", after.Step(), before.Step())
			}
			if after.Done {
				t.Error("Done set despite a validation error")
			}
		})
	}
}

// A hub does not need a key (only runtime and both do), so leaving it blank
// must not block.
func TestHubMayHaveNoKey(t *testing.T) {
	s := hubState().at(StepKey)
	s.Key = ""
	if after := Advance(s); after.Err != "" {
		t.Errorf("hub with no key was blocked: %s", after.Err)
	}
}

// An empty hub URL is a legitimate answer: it just disables self-registration.
func TestEmptyHubURLIsAllowed(t *testing.T) {
	s := runtimeState().at(StepHub)
	s.HubURL = ""
	s.HubKey = ""
	if after := Advance(s); after.Err != "" {
		t.Errorf("runtime with no hub URL was blocked: %s", after.Err)
	}
}

func TestBackNavigationPreservesValues(t *testing.T) {
	s := runtimeState()
	s = s.at(StepDB)
	s.DB = "/custom/path.db"

	back := Back(s)
	if back.Step() != StepAddr {
		t.Fatalf("Back from StepDB went to %v, want StepAddr", back.Step())
	}
	if back.DB != "/custom/path.db" {
		t.Errorf("Back discarded the database path: %q", back.DB)
	}

	forward := Advance(back)
	if forward.Step() != StepDB {
		t.Fatalf("Advance from StepAddr went to %v, want StepDB", forward.Step())
	}
	if forward.DB != "/custom/path.db" {
		t.Errorf("round trip discarded the database path: %q", forward.DB)
	}
}

// Back must skip the same steps Advance skips, or a hub would land on a step
// it never saw on the way in.
func TestBackSkipsInapplicableSteps(t *testing.T) {
	s := hubState().at(StepAuth)
	back := Back(s)
	if back.Step() != StepKey {
		t.Errorf("Back from StepAuth as hub went to %v, want StepKey (machine/public/tailscale/hub steps do not apply)", back.Step())
	}
}

func TestBackFromTheFirstStepStaysPut(t *testing.T) {
	s := NewState(nil, "h")
	if back := Back(s); back.Step() != StepRole {
		t.Errorf("Back from the first step went to %v, want StepRole", back.Step())
	}
}

func TestBackClearsAValidationError(t *testing.T) {
	s := runtimeState().at(StepPublicURL)
	s.PublicURL = "nope"
	blocked := Advance(s)
	if blocked.Err == "" {
		t.Fatal("expected a validation error to set up this test")
	}
	if back := Back(blocked); back.Err != "" {
		t.Errorf("Back kept the stale error %q", back.Err)
	}
}

func TestAbortMarksAbortedAndNeverDone(t *testing.T) {
	s := Abort(runtimeState())
	if !s.Aborted {
		t.Error("Aborted not set")
	}
	if s.Done {
		t.Error("Done set on abort; nothing may be written")
	}
}

// Role defaults differ because a hub listens locally for a browser while a
// runtime must be reachable from the hub across the tailnet.
func TestRoleDefaultsForListenAddress(t *testing.T) {
	tests := []struct {
		role string
		want string
	}{
		{role: "hub", want: "127.0.0.1:8989"},
		{role: "both", want: "127.0.0.1:8989"},
		{role: "runtime", want: "0.0.0.0:9199"},
	}
	for _, tt := range tests {
		t.Run(tt.role, func(t *testing.T) {
			s := NewState(nil, "h")
			s.Role = tt.role
			s = applyRoleDefaults(s)
			if s.Addr != tt.want {
				t.Errorf("addr default for %q = %q, want %q", tt.role, s.Addr, tt.want)
			}
		})
	}
}

// Re-running the wizard against an existing config is the reconfigure path:
// every answer must come back pre-filled rather than reset to a default.
func TestNewStatePrefillsFromExistingConfig(t *testing.T) {
	no := false
	cfg := &config.Config{
		Role:      "runtime",
		Addr:      "10.0.0.5:9000",
		DB:        "/data/rt.db",
		Key:       "existingkey",
		Machine:   config.MachineConfig{Name: "olympia", PublicURL: "https://olympia.ts.net"},
		Hub:       config.HubConfig{URL: "https://hq.ts.net", Key: "hk"},
		Tailscale: config.TailscaleConfig{Serve: &no},
		Auth:      config.AuthConfig{TwoFA: &no},
	}
	s := NewState(cfg, "ignored-hostname")

	if s.Role != "runtime" || s.Addr != "10.0.0.5:9000" || s.DB != "/data/rt.db" || s.Key != "existingkey" {
		t.Errorf("core fields not pre-filled: %+v", s)
	}
	if s.MachineName != "olympia" || s.PublicURL != "https://olympia.ts.net" {
		t.Errorf("machine fields not pre-filled: %+v", s)
	}
	if s.HubURL != "https://hq.ts.net" || s.HubKey != "hk" {
		t.Errorf("hub fields not pre-filled: %+v", s)
	}
	if s.TailscaleServe {
		t.Error("tailscale.serve: false was not carried over")
	}
	if s.TwoFA {
		t.Error("auth.two_fa: false was not carried over — *bool false must survive")
	}
}

// With no config, the machine name defaults to the hostname; the operator
// should not have to type what the OS already knows.
func TestNewStateDefaultsMachineNameToHostname(t *testing.T) {
	if s := NewState(nil, "builder"); s.MachineName != "builder" {
		t.Errorf("machine name = %q, want the hostname %q", s.MachineName, "builder")
	}
}

func TestToConfigMapsEveryAnswer(t *testing.T) {
	s := runtimeState()
	s.TailscaleServe = true
	cfg := ToConfig(s)

	if cfg.Role != "runtime" || cfg.Addr != s.Addr || cfg.DB != s.DB || cfg.Key != "rtkey" {
		t.Errorf("core fields lost: %+v", cfg)
	}
	if cfg.Machine.Name != s.MachineName || cfg.Machine.PublicURL != s.PublicURL {
		t.Errorf("machine fields lost: %+v", cfg.Machine)
	}
	if cfg.Hub.URL != s.HubURL || cfg.Hub.Key != s.HubKey {
		t.Errorf("hub fields lost: %+v", cfg.Hub)
	}
	if cfg.Tailscale.Serve == nil || !*cfg.Tailscale.Serve {
		t.Error("tailscale.serve not written")
	}
}

// A hub's config must not carry runtime identity fields it never asked about.
func TestToConfigOmitsInapplicableFields(t *testing.T) {
	s := hubState()
	s.MachineName = "leftover"
	s.HubURL = "https://leftover"
	cfg := ToConfig(s)
	if cfg.Machine.Name != "" || cfg.Machine.PublicURL != "" {
		t.Errorf("hub config carries machine identity: %+v", cfg.Machine)
	}
	if cfg.Hub.URL != "" {
		t.Errorf("hub config carries a hub registration target: %+v", cfg.Hub)
	}
}

// The written config must survive the strict decoder — the wizard cannot emit
// something its own loader rejects.
func TestToConfigSurvivesARoundTrip(t *testing.T) {
	res, err := Write(t.TempDir(), ToConfig(runtimeState()))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := config.Load(res.ConfigPath); err != nil {
		t.Fatalf("wizard output rejected by the strict decoder: %v", err)
	}
}

func TestRenderReviewGolden(t *testing.T) {
	s := runtimeState()
	s.TailscaleServe = true
	got := RenderReview(s)

	want := strings.Join([]string{
		"Review",
		"",
		"  role            runtime",
		"  machine name    builder",
		"  listen address  0.0.0.0:9199",
		"  database        data/devdeck.db",
		"  key             rtkey",
		"  public URL      https://builder.tail-abc.ts.net",
		"  tailscale serve yes",
		"  hub URL         https://hq.tail-abc.ts.net",
		"  hub key         hubkey",
		"",
		"Nothing has been written yet. Press enter to write devdeck.yaml.",
	}, "\n")

	if got != want {
		t.Errorf("review screen drifted.\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestRenderReviewForHubOmitsRuntimeRows(t *testing.T) {
	got := RenderReview(hubState())
	for _, absent := range []string{"machine name", "public URL", "hub URL", "tailscale serve"} {
		if strings.Contains(got, absent) {
			t.Errorf("hub review shows %q:\n%s", absent, got)
		}
	}
	for _, present := range []string{"role", "listen address", "database", "two-factor"} {
		if !strings.Contains(got, present) {
			t.Errorf("hub review missing %q:\n%s", present, got)
		}
	}
}
