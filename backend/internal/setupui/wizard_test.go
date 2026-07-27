package setupui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"devdeck/backend/internal/config"
)

// key builds the message Bubble Tea v2 delivers for a printable key press.
func key(r rune) tea.KeyPressMsg {
	return tea.KeyPressMsg{Code: r, Text: string(r)}
}

// namedKey builds a press of a special key, e.g. tea.KeyEnter or tea.KeyEsc.
func namedKey(code rune) tea.KeyPressMsg {
	return tea.KeyPressMsg{Code: code}
}

// ctrlKey builds a ctrl-modified press, e.g. ctrl+c.
func ctrlKey(r rune) tea.KeyPressMsg {
	return tea.KeyPressMsg{Code: r, Mod: tea.ModCtrl}
}

// press feeds one key into the model and returns the model that came back.
func press(t *testing.T, m model, msg tea.KeyPressMsg) model {
	t.Helper()
	next, _ := m.Update(msg)
	got, ok := next.(model)
	if !ok {
		t.Fatalf("Update returned %T, want model", next)
	}
	return got
}

func newTestModel(t *testing.T) (model, string) {
	t.Helper()
	dir := t.TempDir()
	return newModel(dir, nil, "builder"), dir
}

// The key names the model switches on must be the strings v2 actually
// produces. If this drifts, every shortcut silently stops working while the
// wizard still compiles — so assert the mapping directly.
func TestKeyNamesMatchBubbleTeaV2(t *testing.T) {
	tests := []struct {
		msg  tea.KeyPressMsg
		want string
	}{
		{ctrlKey('c'), "ctrl+c"},
		{ctrlKey('r'), "ctrl+r"},
		{namedKey(tea.KeyEnter), "enter"},
		{namedKey(tea.KeyEsc), "esc"},
		{namedKey(tea.KeyUp), "up"},
		{namedKey(tea.KeyDown), "down"},
		{namedKey(tea.KeyTab), "tab"},
		// v2 names the space bar "space", not " ". Matching " " compiles fine
		// and silently never fires, which is exactly what this test exists to
		// catch.
		{key(' '), "space"},
	}
	for _, tt := range tests {
		if got := tt.msg.String(); got != tt.want {
			t.Errorf("KeyPressMsg.String() = %q, want %q", got, tt.want)
		}
	}
}

func TestModelStartsOnRoleWithDefaultsApplied(t *testing.T) {
	m, _ := newTestModel(t)
	if m.state.Step() != StepRole {
		t.Errorf("first step = %v, want StepRole", m.state.Step())
	}
	if m.state.Addr != defaultHubAddr {
		t.Errorf("addr = %q, want the hub default %q", m.state.Addr, defaultHubAddr)
	}
	if m.state.MachineName != "builder" {
		t.Errorf("machine name = %q, want the hostname", m.state.MachineName)
	}
}

// ctrl+c must abort without writing anything. This is the guarantee that makes
// it safe to explore the wizard on a machine that already has a config.
func TestCtrlCAbortsAndWritesNothing(t *testing.T) {
	m, dir := newTestModel(t)
	m = press(t, m, ctrlKey('c'))

	if !m.state.Aborted {
		t.Error("ctrl+c did not set Aborted")
	}
	if m.state.Done {
		t.Error("ctrl+c set Done")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("ctrl+c left %d file(s) behind: %v", len(entries), entries)
	}
}

func TestArrowKeysSelectTheRole(t *testing.T) {
	m, _ := newTestModel(t)
	if m.state.Role != "hub" {
		t.Fatalf("starting role = %q, want hub", m.state.Role)
	}
	m = press(t, m, namedKey(tea.KeyDown))
	if m.state.Role != "runtime" {
		t.Errorf("after down, role = %q, want runtime", m.state.Role)
	}
	m = press(t, m, namedKey(tea.KeyDown))
	if m.state.Role != "both" {
		t.Errorf("after two downs, role = %q, want both", m.state.Role)
	}
	// Selection must clamp rather than wrap off the end of the list.
	m = press(t, m, namedKey(tea.KeyDown))
	if m.state.Role != "both" {
		t.Errorf("after a third down, role = %q, want it clamped at both", m.state.Role)
	}
	m = press(t, m, namedKey(tea.KeyUp))
	if m.state.Role != "runtime" {
		t.Errorf("after up, role = %q, want runtime", m.state.Role)
	}
}

func TestEnterAdvancesPastTheRoleStep(t *testing.T) {
	m, _ := newTestModel(t)
	m = press(t, m, namedKey(tea.KeyEnter))
	if m.state.Step() != StepAddr {
		t.Errorf("hub advanced to %v, want StepAddr (machine name does not apply)", m.state.Step())
	}
}

func TestRuntimeAdvancesToMachineName(t *testing.T) {
	m, _ := newTestModel(t)
	m = press(t, m, namedKey(tea.KeyDown)) // runtime
	m = press(t, m, namedKey(tea.KeyEnter))
	if m.state.Step() != StepMachineName {
		t.Errorf("runtime advanced to %v, want StepMachineName", m.state.Step())
	}
	// Choosing runtime must also swap in the runtime listen-address default.
	if m.state.Addr != defaultRuntimeAddr {
		t.Errorf("addr = %q, want the runtime default %q", m.state.Addr, defaultRuntimeAddr)
	}
}

func TestEscGoesBackAndKeepsTheAnswer(t *testing.T) {
	m, _ := newTestModel(t)
	m = press(t, m, namedKey(tea.KeyEnter)) // -> StepAddr
	if m.state.Step() != StepAddr {
		t.Fatalf("setup: step = %v", m.state.Step())
	}
	m = press(t, m, namedKey(tea.KeyEsc))
	if m.state.Step() != StepRole {
		t.Errorf("esc went to %v, want StepRole", m.state.Step())
	}
	if m.state.Role != "hub" {
		t.Errorf("esc discarded the role: %q", m.state.Role)
	}
}

// A validation failure must surface inline and hold position — it must never
// silently skip the step or advance with a bad value.
func TestInvalidInputBlocksAndShowsTheMessage(t *testing.T) {
	m, _ := newTestModel(t)
	m = press(t, m, namedKey(tea.KeyEnter)) // -> StepAddr
	m.inputs[StepAddr][0].SetValue("no-port-here")
	m = press(t, m, namedKey(tea.KeyEnter))

	if m.state.Step() != StepAddr {
		t.Errorf("advanced to %v despite an invalid address", m.state.Step())
	}
	if m.state.Err == "" {
		t.Fatal("no validation message was set")
	}
	if !strings.Contains(m.render(), m.state.Err) {
		t.Error("the validation message is not shown on screen")
	}
}

func TestCtrlRGeneratesAKey(t *testing.T) {
	m, _ := newTestModel(t)
	m.state = m.state.at(StepKey)
	before := m.state.Key

	m = press(t, m, ctrlKey('r'))
	if m.state.Key == before || m.state.Key == "" {
		t.Fatalf("ctrl+r did not generate a key (before %q, after %q)", before, m.state.Key)
	}
	if len(m.state.Key) != 64 {
		t.Errorf("generated key is %d chars, want 64 (32 bytes hex)", len(m.state.Key))
	}
	if got := m.inputs[StepKey][0].Value(); got != m.state.Key {
		t.Errorf("the visible input still shows %q, want the generated key", got)
	}
}

func TestSpaceTogglesTailscaleServe(t *testing.T) {
	m, _ := newTestModel(t)
	m.state.Role = "runtime"
	m.state = m.state.at(StepTailscale)
	before := m.state.TailscaleServe

	m = press(t, m, key(' '))
	if m.state.TailscaleServe == before {
		t.Error("space did not toggle tailscale serve")
	}
}

func TestAuthStepTogglesTheFocusedRow(t *testing.T) {
	m, _ := newTestModel(t)
	m.state = m.state.at(StepAuth)

	m = press(t, m, key(' '))
	if m.state.TwoFA {
		t.Error("space on the first row did not toggle two-factor")
	}
	if !m.state.SecureCookies {
		t.Error("space on the first row wrongly toggled secure cookies")
	}

	m = press(t, m, namedKey(tea.KeyDown))
	m = press(t, m, key(' '))
	if m.state.SecureCookies {
		t.Error("space on the second row did not toggle secure cookies")
	}
}

// The hub step holds two fields; enter moves between them before it advances.
func TestEnterMovesBetweenTheHubFieldsFirst(t *testing.T) {
	m, _ := newTestModel(t)
	m.state.Role = "runtime"
	m.state = m.state.at(StepHub)

	if m.cursor != 0 {
		t.Fatalf("cursor = %d, want 0", m.cursor)
	}
	m = press(t, m, namedKey(tea.KeyEnter))
	if m.cursor != 1 {
		t.Errorf("cursor = %d after enter, want 1 (still inside the hub step)", m.cursor)
	}
	if m.state.Step() != StepHub {
		t.Errorf("advanced off the hub step at cursor 0: now %v", m.state.Step())
	}
}

// A hub URL triggers the live check before the wizard will move on, so a wrong
// key is seen here rather than 30 seconds after boot.
func TestHubStepChecksBeforeAdvancing(t *testing.T) {
	m, _ := newTestModel(t)
	m.state.Role = "runtime"
	m.state = m.state.at(StepHub)
	m.inputs[StepHub][0].SetValue("https://hq.example")
	m.inputs[StepHub][1].SetValue("hubkey")
	m.cursor = 1

	m = press(t, m, namedKey(tea.KeyEnter))
	if m.state.Step() != StepHub {
		t.Errorf("advanced to %v without running the hub check", m.state.Step())
	}
	if !m.probing {
		t.Error("the hub check was not started")
	}

	// Once the verdict lands, a second enter continues even on failure.
	next, _ := m.Update(hubMsg(HubResult{Status: HubUnreachable, Detail: "connection refused"}))
	m = next.(model)
	if !m.hubChecked || m.probing {
		t.Fatalf("hub verdict not recorded: checked=%v probing=%v", m.hubChecked, m.probing)
	}
	if !strings.Contains(m.render(), "connection refused") {
		t.Error("the hub failure detail is not shown to the operator")
	}
	m = press(t, m, namedKey(tea.KeyEnter))
	if m.state.Step() != StepReview {
		t.Errorf("second enter went to %v, want StepReview (continue anyway)", m.state.Step())
	}
}

// An empty hub URL means "no self-registration" and must not trigger a check.
func TestEmptyHubURLSkipsTheCheck(t *testing.T) {
	m, _ := newTestModel(t)
	m.state.Role = "runtime"
	m.state = m.state.at(StepHub)
	m.cursor = 1

	m = press(t, m, namedKey(tea.KeyEnter))
	if m.probing {
		t.Error("an empty hub URL still triggered a network check")
	}
	if m.state.Step() != StepReview {
		t.Errorf("step = %v, want StepReview", m.state.Step())
	}
}

// Tailscale detection only suggests; it must never overwrite a URL the
// operator already typed.
func TestTailscaleProbeDoesNotOverwriteATypedURL(t *testing.T) {
	m, _ := newTestModel(t)
	m.state.Role = "runtime"
	m.state = m.state.at(StepPublicURL)
	m.state.PublicURL = "https://typed.example"

	next, _ := m.Update(tailscaleMsg(TailscaleResult{URL: "https://detected.ts.net"}))
	m = next.(model)
	if m.state.PublicURL != "https://typed.example" {
		t.Errorf("public URL = %q, want the typed value kept", m.state.PublicURL)
	}
}

func TestTailscaleProbeFillsAnEmptyURL(t *testing.T) {
	m, _ := newTestModel(t)
	m.state.Role = "runtime"
	m.state = m.state.at(StepPublicURL)
	m.state.PublicURL = ""

	next, _ := m.Update(tailscaleMsg(TailscaleResult{URL: "https://detected.ts.net"}))
	m = next.(model)
	if m.state.PublicURL != "https://detected.ts.net" {
		t.Errorf("public URL = %q, want the detected tailnet URL", m.state.PublicURL)
	}
	if !m.state.TailscaleServe {
		t.Error("finding a tailnet URL should pre-answer tailscale serve as yes")
	}
}

// Falling back to http://<addr> keeps the wizard usable with no Tailscale.
func TestTailscaleFailureFallsBackToTheListenAddress(t *testing.T) {
	m, _ := newTestModel(t)
	m.state.Role = "runtime"
	m.state.Addr = "0.0.0.0:9199"
	m.state = m.state.at(StepPublicURL)
	m.state.PublicURL = ""

	next, _ := m.Update(tailscaleMsg(TailscaleResult{Reason: ReasonNotInstalled}))
	m = next.(model)
	if m.state.PublicURL != "http://0.0.0.0:9199" {
		t.Errorf("public URL = %q, want the http://<addr> fallback", m.state.PublicURL)
	}
	if m.state.TailscaleServe {
		t.Error("tailscale serve should stay off when Tailscale is not installed")
	}
}

// Confirming the review step is the only thing that writes.
func TestConfirmingReviewWritesTheConfig(t *testing.T) {
	m, dir := newTestModel(t)
	m.state.Role = "runtime"
	m.state.MachineName = "builder"
	m.state.Key = "abc123"
	m.state.PublicURL = "https://builder.ts.net"
	m.state = m.state.at(StepReview)

	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("files existed before the review was confirmed: %v", entries)
	}

	m = press(t, m, namedKey(tea.KeyEnter))
	if !m.state.Done {
		t.Fatal("enter on the review step did not set Done")
	}
	if m.err != nil {
		t.Fatalf("write failed: %v", m.err)
	}
	if _, err := os.Stat(filepath.Join(dir, config.FileName)); err != nil {
		t.Errorf("devdeck.yaml not written: %v", err)
	}
	if m.result.ConnectionLine == "" {
		t.Error("no connection line produced for a runtime")
	}
}

// Every step must render without panicking, for every role — the renderer
// indexes into per-step input slices and a mismatch would only show up here.
func TestRenderIsSafeForEveryStepAndRole(t *testing.T) {
	for _, role := range roleOptions {
		for _, step := range AllSteps {
			if !Applies(step, role) {
				continue
			}
			m, _ := newTestModel(t)
			m.state.Role = role
			m.state = m.state.at(step)
			if out := m.render(); out == "" {
				t.Errorf("role %s step %v rendered empty", role, step)
			}
		}
	}
}

// The step counter must describe the steps this role actually sees.
func TestStepCounterCountsOnlyVisibleSteps(t *testing.T) {
	m, _ := newTestModel(t)
	m.state.Role = "hub"
	if got := m.visibleTotal(); got != 6 {
		t.Errorf("hub sees %d steps, want 6", got)
	}
	m.state.Role = "runtime"
	if got := m.visibleTotal(); got != 9 {
		t.Errorf("runtime sees %d steps, want 9", got)
	}
}

func TestViewUsesTheAlternateScreen(t *testing.T) {
	m, _ := newTestModel(t)
	if !m.View().AltScreen {
		t.Error("View().AltScreen is false; the wizard would scribble over the scrollback")
	}
}
