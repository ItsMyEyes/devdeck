// This file is the terminal shell around the pure step machine in steps.go.
// It owns Bubble Tea and nothing else: every decision about what is valid,
// which step comes next, and what gets written lives in steps.go / write.go,
// so the wizard's behaviour is testable without a terminal.
//
// NOTE: this targets Bubble Tea v2 (charm.land/bubbletea/v2). v2 differs from
// the v1 examples in three ways that matter here — View returns a tea.View
// rather than a string, the alternate screen is a field on that View rather
// than a program option, and key presses arrive as tea.KeyPressMsg.
package setupui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"

	"devdeck/backend/internal/config"
)

// ErrAborted is returned when the operator pressed ctrl+c. Nothing has been
// written when this is returned.
var ErrAborted = errors.New("setup cancelled")

// Options configures a wizard run.
type Options struct {
	// Dir is where devdeck.yaml and copy-this.md are written.
	Dir string
	// Existing pre-fills every answer, making this the reconfigure path. Nil
	// for a first run.
	Existing *config.Config
	// Hostname supplies the machine-name default. Empty falls back to the OS
	// hostname.
	Hostname string
}

// Run shows the wizard and, once the review step is confirmed, writes
// devdeck.yaml (plus copy-this.md for a runtime). It returns ErrAborted if the
// operator cancelled, in which case nothing was written.
func Run(ctx context.Context, opts Options) (Result, error) {
	hostname := opts.Hostname
	if hostname == "" {
		if h, err := os.Hostname(); err == nil {
			hostname = h
		} else {
			hostname = "devdeck"
		}
	}

	final, err := tea.NewProgram(newModel(opts.Dir, opts.Existing, hostname), tea.WithContext(ctx)).Run()
	if err != nil {
		return Result{}, err
	}
	m, ok := final.(model)
	if !ok {
		return Result{}, fmt.Errorf("setupui: unexpected final model %T", final)
	}
	if m.err != nil {
		return Result{}, m.err
	}
	if !m.state.Done {
		return Result{}, ErrAborted
	}
	return m.result, nil
}

// fieldCount is how many focusable inputs a step shows. Steps with more than
// one use enter to move between them and advance only from the last.
func fieldCount(step StepID) int {
	switch step {
	case StepHub, StepAuth:
		return 2
	default:
		return 1
	}
}

type model struct {
	state  State
	dir    string
	cursor int

	// One text input per text-valued step, kept across steps so back
	// navigation shows what was typed.
	inputs map[StepID][]textinput.Model

	spin    spinner.Model
	probing bool

	// hubChecked gates advancing past the hub step: the first enter runs the
	// live check, the second continues regardless of the outcome. That is what
	// "continue anyway" means without hiding a failure.
	hubChecked bool

	result Result
	err    error
}

// roleOptions is the selectable list on the first step.
var roleOptions = []string{"hub", "runtime", "both"}

func newModel(dir string, existing *config.Config, hostname string) model {
	s := NewState(existing, hostname)
	s = applyRoleDefaults(s)

	m := model{
		state:  s,
		dir:    dir,
		inputs: map[StepID][]textinput.Model{},
		spin:   spinner.New(),
	}
	for _, step := range []StepID{StepMachineName, StepAddr, StepDB, StepKey, StepPublicURL} {
		m.inputs[step] = []textinput.Model{newInput(m.valueFor(step, 0))}
	}
	m.inputs[StepHub] = []textinput.Model{newInput(s.HubURL), newInput(s.HubKey)}
	return m
}

func newInput(value string) textinput.Model {
	ti := textinput.New()
	ti.SetValue(value)
	return ti
}

// valueFor reads the state field backing a given step's input.
func (m model) valueFor(step StepID, idx int) string {
	switch step {
	case StepMachineName:
		return m.state.MachineName
	case StepAddr:
		return m.state.Addr
	case StepDB:
		return m.state.DB
	case StepKey:
		return m.state.Key
	case StepPublicURL:
		return m.state.PublicURL
	case StepHub:
		if idx == 1 {
			return m.state.HubKey
		}
		return m.state.HubURL
	}
	return ""
}

// syncFromInputs copies the visible text inputs back into the state before a
// transition, so validation sees what the operator actually typed.
func (m *model) syncFromInputs() {
	get := func(step StepID, idx int) string {
		if ins, ok := m.inputs[step]; ok && idx < len(ins) {
			return ins[idx].Value()
		}
		return ""
	}
	switch m.state.step {
	case StepMachineName:
		m.state.MachineName = get(StepMachineName, 0)
	case StepAddr:
		m.state.Addr = get(StepAddr, 0)
	case StepDB:
		m.state.DB = get(StepDB, 0)
	case StepKey:
		m.state.Key = get(StepKey, 0)
	case StepPublicURL:
		m.state.PublicURL = get(StepPublicURL, 0)
	case StepHub:
		m.state.HubURL = get(StepHub, 0)
		m.state.HubKey = get(StepHub, 1)
	}
}

// refreshInputs pushes state back into the inputs, used after a transition
// changes a value the operator did not type (a generated key, a probed URL).
func (m *model) refreshInputs() {
	for step, ins := range m.inputs {
		for i := range ins {
			ins[i].SetValue(m.valueFor(step, i))
		}
	}
}

// focus points the cursor at the current step's active input.
func (m *model) focus() tea.Cmd {
	var cmd tea.Cmd
	for step, ins := range m.inputs {
		for i := range ins {
			if step == m.state.step && i == m.cursor {
				cmd = ins[i].Focus()
			} else {
				ins[i].Blur()
			}
		}
	}
	return cmd
}

type tailscaleMsg TailscaleResult
type hubMsg HubResult

// probeTailscaleCmd runs detection off the UI goroutine.
func probeTailscaleCmd() tea.Cmd {
	return func() tea.Msg { return tailscaleMsg(ProbeTailscale()) }
}

func checkHubCmd(hubURL, hubKey string) tea.Cmd {
	return func() tea.Msg { return hubMsg(CheckHub(context.Background(), hubURL, hubKey)) }
}

func (m model) Init() tea.Cmd {
	return tea.Batch(m.focus(), m.spin.Tick)
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tailscaleMsg:
		m.probing = false
		m.state.Tailscale = TailscaleResult(msg)
		// Only suggest a public URL; never overwrite one already typed.
		if strings.TrimSpace(m.state.PublicURL) == "" {
			m.state.PublicURL = m.state.Tailscale.PublicURL(m.state.Addr)
			m.state.TailscaleServe = m.state.Tailscale.Found()
			m.refreshInputs()
		}
		return m, nil

	case hubMsg:
		m.probing = false
		m.state.Hub = HubResult(msg)
		m.hubChecked = true
		return m, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		return m, cmd

	case tea.KeyPressMsg:
		return m.onKey(msg)
	}

	return m, m.updateInputs(msg)
}

func (m *model) updateInputs(msg tea.Msg) tea.Cmd {
	ins, ok := m.inputs[m.state.step]
	if !ok || m.cursor >= len(ins) {
		return nil
	}
	var cmd tea.Cmd
	ins[m.cursor], cmd = ins[m.cursor].Update(msg)
	return cmd
}

func (m model) onKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		m.state = Abort(m.state)
		return m, tea.Quit

	case "esc", "shift+tab":
		m.state = Back(m.state)
		m.cursor = 0
		m.hubChecked = false
		return m, m.focus()

	case "enter":
		return m.onEnter()

	case "up":
		return m.onUpDown(-1)

	case "down", "tab":
		return m.onUpDown(1)
	}

	// Step-specific shortcuts.
	switch m.state.step {
	case StepKey:
		if msg.String() == "ctrl+r" {
			m.state.Key = GenerateKey()
			m.refreshInputs()
			return m, nil
		}
	case StepTailscale, StepAuth:
		// v2 reports the space bar as "space"; TestKeyNamesMatchBubbleTeaV2
		// pins that name so this cannot silently rot.
		switch msg.String() {
		case "space", "left", "right":
			m.toggle()
			return m, nil
		}
	}

	return m, m.updateInputs(msg)
}

// onUpDown moves within a step: between role options, between the two toggles
// of the auth step, or between the hub step's URL and key.
func (m model) onUpDown(delta int) (tea.Model, tea.Cmd) {
	if m.state.step == StepRole {
		idx := indexOf(roleOptions, m.state.Role) + delta
		if idx < 0 {
			idx = 0
		}
		if idx >= len(roleOptions) {
			idx = len(roleOptions) - 1
		}
		m.state.Role = roleOptions[idx]
		return m, nil
	}

	n := fieldCount(m.state.step)
	m.cursor += delta
	if m.cursor < 0 {
		m.cursor = 0
	}
	if m.cursor >= n {
		m.cursor = n - 1
	}
	return m, m.focus()
}

func (m *model) toggle() {
	switch m.state.step {
	case StepTailscale:
		m.state.TailscaleServe = !m.state.TailscaleServe
	case StepAuth:
		if m.cursor == 1 {
			m.state.SecureCookies = !m.state.SecureCookies
		} else {
			m.state.TwoFA = !m.state.TwoFA
		}
	}
}

func (m model) onEnter() (tea.Model, tea.Cmd) {
	// Within a multi-field step, enter moves to the next field first.
	if n := fieldCount(m.state.step); m.cursor < n-1 {
		m.syncFromInputs()
		m.cursor++
		return m, m.focus()
	}

	m.syncFromInputs()

	// The hub step runs its live check on the first enter and continues on the
	// second, so a failure is always seen before it is passed over.
	if m.state.step == StepHub && strings.TrimSpace(m.state.HubURL) != "" && !m.hubChecked {
		if msg := validate(m.state); msg != "" {
			m.state.Err = msg
			return m, nil
		}
		m.probing = true
		return m, checkHubCmd(m.state.HubURL, m.state.HubKey)
	}

	next := Advance(m.state)
	if next.Err != "" {
		m.state = next
		return m, nil
	}
	m.state = next
	m.cursor = 0
	m.hubChecked = false

	if m.state.Done {
		res, err := Write(m.dir, ToConfig(m.state))
		if err != nil {
			m.err = err
		}
		m.result = res
		return m, tea.Quit
	}

	// Entering the public-URL step kicks off Tailscale detection.
	if m.state.step == StepPublicURL && m.state.Tailscale == (TailscaleResult{}) {
		m.probing = true
		return m, tea.Batch(m.focus(), probeTailscaleCmd())
	}
	return m, m.focus()
}

func indexOf(list []string, want string) int {
	for i, v := range list {
		if v == want {
			return i
		}
	}
	return 0
}

func (m model) View() tea.View {
	v := tea.NewView(m.render())
	v.AltScreen = true
	return v
}

// stepPrompt is the question and hint shown above each step's input.
func stepPrompt(step StepID) (title, hint string) {
	switch step {
	case StepRole:
		return "What does this machine do?",
			"hub = dashboard + registry · runtime = execution only · both = solo, all-in-one"
	case StepMachineName:
		return "Machine name", "How this machine appears in the hub's Machines list."
	case StepAddr:
		return "Listen address", "A runtime must be reachable from the hub, so bind 0.0.0.0."
	case StepDB:
		return "Database path", "SQLite file. Relative paths are resolved from the binary."
	case StepKey:
		return "API key", "ctrl+r generates a new one. Required for runtime and both."
	case StepPublicURL:
		return "Public URL", "The address the hub will reach this machine at."
	case StepTailscale:
		return "Expose on your tailnet?", "Runs `tailscale serve` alongside the server."
	case StepHub:
		return "Hub to register with", "Leave the URL blank to skip self-registration."
	case StepAuth:
		return "Login hardening", "Disable secure cookies only for loopback desktop use."
	case StepReview:
		return "Review", ""
	}
	return "", ""
}

func (m model) render() string {
	var b strings.Builder

	b.WriteString("devdeck setup\n")
	b.WriteString(strings.Repeat("─", 60) + "\n\n")

	if m.state.step == StepReview {
		b.WriteString(RenderReview(m.state))
		b.WriteString("\n\n" + m.footer())
		return b.String()
	}

	title, hint := stepPrompt(m.state.step)
	fmt.Fprintf(&b, "%s  (step %d of %d)\n", title, m.visibleIndex()+1, m.visibleTotal())
	if hint != "" {
		b.WriteString(hint + "\n")
	}
	b.WriteString("\n")

	switch m.state.step {
	case StepRole:
		for _, opt := range roleOptions {
			marker := "  "
			if opt == m.state.Role {
				marker = "> "
			}
			b.WriteString(marker + opt + "\n")
		}

	case StepTailscale:
		b.WriteString("  " + checkbox(m.state.TailscaleServe) + " run `tailscale serve`\n")

	case StepAuth:
		b.WriteString("  " + cursorMark(m.cursor == 0) + checkbox(m.state.TwoFA) + " require TOTP two-factor login\n")
		b.WriteString("  " + cursorMark(m.cursor == 1) + checkbox(m.state.SecureCookies) + " set Secure on auth cookies\n")

	case StepHub:
		b.WriteString("  hub URL  " + m.inputs[StepHub][0].View() + "\n")
		b.WriteString("  hub key  " + m.inputs[StepHub][1].View() + "\n")

	default:
		if ins, ok := m.inputs[m.state.step]; ok {
			b.WriteString("  " + ins[0].View() + "\n")
		}
	}

	if m.probing {
		b.WriteString("\n  " + m.spin.View() + " checking…\n")
	}
	if m.state.step == StepPublicURL && m.state.Tailscale != (TailscaleResult{}) {
		b.WriteString("\n  " + m.state.Tailscale.Message() + "\n")
	}
	if m.state.step == StepHub && m.state.Hub.Status != HubUnknown {
		mark := "✗"
		if m.state.Hub.OK() {
			mark = "✓"
		}
		b.WriteString("\n  " + mark + " " + m.state.Hub.Detail + "\n")
		if !m.state.Hub.OK() {
			b.WriteString("  press enter again to continue anyway\n")
		}
	}
	if m.state.Err != "" {
		b.WriteString("\n  ! " + m.state.Err + "\n")
	}

	b.WriteString("\n" + m.footer())
	return b.String()
}

func (m model) footer() string {
	keys := []string{"enter continue", "esc back", "ctrl+c cancel"}
	if m.state.step == StepKey {
		keys = append([]string{"ctrl+r regenerate"}, keys...)
	}
	if m.state.step == StepRole || m.state.step == StepAuth {
		keys = append([]string{"↑/↓ select"}, keys...)
	}
	if m.state.step == StepTailscale {
		keys = append([]string{"space toggle"}, keys...)
	}
	return strings.Repeat("─", 60) + "\n" + strings.Join(keys, " · ")
}

func checkbox(on bool) string {
	if on {
		return "[x]"
	}
	return "[ ]"
}

func cursorMark(on bool) string {
	if on {
		return "> "
	}
	return "  "
}

// visibleIndex and visibleTotal number the steps this role actually sees, so
// a hub does not read "step 3 of 10" while skipping four of them.
func (m model) visibleIndex() int {
	idx := 0
	for _, step := range AllSteps {
		if step == m.state.step {
			return idx
		}
		if Applies(step, m.state.Role) {
			idx++
		}
	}
	return idx
}

func (m model) visibleTotal() int {
	n := 0
	for _, step := range AllSteps {
		if Applies(step, m.state.Role) {
			n++
		}
	}
	return n
}
