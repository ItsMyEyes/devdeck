package main

import (
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"devdeck/backend/internal/config"
)

// ---------------------------------------------------------------------------
// Subcommand dispatch
// ---------------------------------------------------------------------------

func TestStripSetupArg(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		wantArgs []string
		wantCmd  bool
	}{
		{
			name:     "no arguments at all",
			args:     []string{"devdeck"},
			wantArgs: []string{"devdeck"},
		},
		{
			name:     "nil args cannot panic",
			args:     nil,
			wantArgs: nil,
		},
		{
			name:     "bare setup",
			args:     []string{"devdeck", "setup"},
			wantArgs: []string{"devdeck"},
			wantCmd:  true,
		},
		{
			name:     "setup keeps trailing flags for the wizard",
			args:     []string{"devdeck", "setup", "--config", "/etc/devdeck.yaml"},
			wantArgs: []string{"devdeck", "--config", "/etc/devdeck.yaml"},
			wantCmd:  true,
		},
		{
			name:     "flags are never a subcommand",
			args:     []string{"devdeck", "--role", "runtime"},
			wantArgs: []string{"devdeck", "--role", "runtime"},
		},
		{
			name:     "single-dash flags are never a subcommand",
			args:     []string{"devdeck", "-setup"},
			wantArgs: []string{"devdeck", "-setup"},
		},
		{
			name:     "setup only counts in first position",
			args:     []string{"devdeck", "--role", "hub", "setup"},
			wantArgs: []string{"devdeck", "--role", "hub", "setup"},
		},
		{
			name:     "unknown subcommand is left alone for flag.Parse",
			args:     []string{"devdeck", "serve"},
			wantArgs: []string{"devdeck", "serve"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotArgs, gotCmd := stripSetupArg(tt.args)
			if gotCmd != tt.wantCmd {
				t.Errorf("setup = %v, want %v", gotCmd, tt.wantCmd)
			}
			if strings.Join(gotArgs, " ") != strings.Join(tt.wantArgs, " ") {
				t.Errorf("args = %q, want %q", gotArgs, tt.wantArgs)
			}
		})
	}
}

// stripSetupArg must not scribble on the caller's slice: main passes os.Args
// straight in, and everything downstream (flag.Parse, the wizard) reads it.
func TestStripSetupArgDoesNotMutateInput(t *testing.T) {
	args := []string{"devdeck", "setup", "--config", "x.yaml"}
	stripSetupArg(args)
	want := []string{"devdeck", "setup", "--config", "x.yaml"}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("input mutated: got %q, want %q", args, want)
		}
	}
}

// ---------------------------------------------------------------------------
// --managed, read before flag.Parse
// ---------------------------------------------------------------------------

func TestManagedFromArgs(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		wantValue bool
		wantOK    bool
	}{
		{name: "absent", args: []string{"devdeck", "--role", "hub"}},
		{name: "double dash bare", args: []string{"devdeck", "--managed"}, wantValue: true, wantOK: true},
		{name: "single dash bare", args: []string{"devdeck", "-managed"}, wantValue: true, wantOK: true},
		{name: "explicit true", args: []string{"devdeck", "--managed=true"}, wantValue: true, wantOK: true},
		{name: "explicit false", args: []string{"devdeck", "--managed=false"}, wantValue: false, wantOK: true},
		{name: "explicit 1", args: []string{"devdeck", "-managed=1"}, wantValue: true, wantOK: true},
		{name: "explicit 0", args: []string{"devdeck", "-managed=0"}, wantValue: false, wantOK: true},
		{name: "unparseable value is ignored", args: []string{"devdeck", "--managed=yes-please"}},
		{name: "after the -- terminator", args: []string{"devdeck", "--", "--managed"}},
		{name: "a different flag with the same prefix", args: []string{"devdeck", "--managed-by=x"}},
		{name: "value of another flag", args: []string{"devdeck", "--name", "--managed"}, wantValue: true, wantOK: true},
		{name: "later position still counts", args: []string{"devdeck", "--role", "hub", "--managed", "--open=false"}, wantValue: true, wantOK: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotValue, gotOK := managedFromArgs(tt.args)
			if gotOK != tt.wantOK || gotValue != tt.wantValue {
				t.Errorf("managedFromArgs(%q) = (%v, %v), want (%v, %v)", tt.args, gotValue, gotOK, tt.wantValue, tt.wantOK)
			}
		})
	}
}

// managedFromArgs is a pre-parse approximation, so it must agree with what
// flag.Parse concludes for every form the flag package actually accepts.
func TestManagedFromArgsMatchesFlagPackage(t *testing.T) {
	for _, args := range [][]string{
		{"--managed"},
		{"-managed"},
		{"--managed=true"},
		{"--managed=false"},
		{"-managed=1"},
		{"-managed=0"},
		{"--role", "hub"},
		{"--role", "hub", "--managed", "--open=false"},
	} {
		fs := flag.NewFlagSet("devdeck", flag.ContinueOnError)
		fs.SetOutput(io.Discard)
		managed := fs.Bool("managed", false, "")
		fs.String("role", "hub", "")
		fs.Bool("open", true, "")
		if err := fs.Parse(args); err != nil {
			t.Fatalf("flag.Parse(%q): %v", args, err)
		}
		got, ok := managedFromArgs(append([]string{"devdeck"}, args...))
		if !ok {
			got = false
		}
		if got != *managed {
			t.Errorf("managedFromArgs(%q) = %v, flag package says %v", args, got, *managed)
		}
	}
}

func TestIsManaged(t *testing.T) {
	tests := []struct {
		name string
		args []string
		env  string
		want bool
	}{
		{name: "neither", args: []string{"devdeck"}},
		{name: "flag only", args: []string{"devdeck", "--managed"}, want: true},
		{name: "env only", args: []string{"devdeck"}, env: "true", want: true},
		{name: "env 1", args: []string{"devdeck"}, env: "1", want: true},
		{name: "env false", args: []string{"devdeck"}, env: "false"},
		{name: "env garbage falls back to unset", args: []string{"devdeck"}, env: "maybe"},
		{name: "flag beats env true", args: []string{"devdeck", "--managed=false"}, env: "true"},
		{name: "flag beats env false", args: []string{"devdeck", "--managed"}, env: "false", want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isManaged(tt.args, tt.env); got != tt.want {
				t.Errorf("isManaged(%q, %q) = %v, want %v", tt.args, tt.env, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// What to do when no config file was found
// ---------------------------------------------------------------------------

func TestDecideNoConfig(t *testing.T) {
	tests := []struct {
		name      string
		usedPath  string
		stdinTTY  bool
		stdoutTTY bool
		managed   bool
		want      bootAction
	}{
		{
			name:      "config file found: nothing to do",
			usedPath:  "/opt/devdeck/devdeck.yaml",
			stdinTTY:  true,
			stdoutTTY: true,
			want:      bootServer,
		},
		{
			name:      "interactive terminal: run the wizard",
			stdinTTY:  true,
			stdoutTTY: true,
			want:      bootWizard,
		},
		{
			name:      "managed by the desktop sidecar: never prompt",
			stdinTTY:  true,
			stdoutTTY: true,
			managed:   true,
			want:      bootWriteDefaults,
		},
		{
			name:      "stdout piped: never prompt",
			stdinTTY:  true,
			stdoutTTY: false,
			want:      bootWriteDefaults,
		},
		{
			name:      "stdin redirected: never prompt",
			stdinTTY:  false,
			stdoutTTY: true,
			want:      bootWriteDefaults,
		},
		{
			name: "headless service: never prompt",
			want: bootWriteDefaults,
		},
		{
			name:     "managed with a config file still just boots",
			usedPath: "/opt/devdeck/devdeck.yaml",
			managed:  true,
			want:     bootServer,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := decideBoot(tt.usedPath, tt.stdinTTY, tt.stdoutTTY, tt.managed)
			if got != tt.want {
				t.Errorf("decideBoot(%q, %v, %v, %v) = %v, want %v",
					tt.usedPath, tt.stdinTTY, tt.stdoutTTY, tt.managed, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Precedence: flag > env > YAML > built-in default
// ---------------------------------------------------------------------------

// declareFlags mirrors the composition main.go performs for each flag. If this
// drifts from main.go the precedence guarantee is gone, which is why the
// pattern is asserted here rather than only in internal/config.
func TestFlagPrecedence(t *testing.T) {
	tests := []struct {
		name    string
		yaml    string
		env     string
		cmdline []string
		want    string
	}{
		{name: "built-in default", want: "127.0.0.1:8989"},
		{name: "yaml beats built-in", yaml: "0.0.0.0:9199", want: "0.0.0.0:9199"},
		{name: "env beats yaml", yaml: "0.0.0.0:9199", env: "1.2.3.4:1", want: "1.2.3.4:1"},
		{name: "flag beats env", yaml: "0.0.0.0:9199", env: "1.2.3.4:1", cmdline: []string{"--addr", "5.6.7.8:2"}, want: "5.6.7.8:2"},
		{name: "flag beats yaml", yaml: "0.0.0.0:9199", cmdline: []string{"--addr", "5.6.7.8:2"}, want: "5.6.7.8:2"},
		{name: "empty yaml value is unset", yaml: "", want: "127.0.0.1:8989"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.env != "" {
				t.Setenv("DEVDECK_ADDR", tt.env)
			} else {
				t.Setenv("DEVDECK_ADDR", "")
			}
			cfg := &config.Config{Addr: tt.yaml}
			fs := flag.NewFlagSet("devdeck", flag.ContinueOnError)
			fs.SetOutput(io.Discard)
			addr := fs.String("addr", envOr("DEVDECK_ADDR", config.Pick(cfg.Addr, "127.0.0.1:8989")), "")
			if err := fs.Parse(tt.cmdline); err != nil {
				t.Fatalf("parse: %v", err)
			}
			if *addr != tt.want {
				t.Errorf("addr = %q, want %q", *addr, tt.want)
			}
		})
	}
}

// A boolean YAML key set to false must survive, which only works because
// PickBool keys off nil rather than off the zero value.
func TestBoolPrecedence(t *testing.T) {
	no := false
	tests := []struct {
		name    string
		yaml    *bool
		env     string
		cmdline []string
		want    bool
	}{
		{name: "built-in default true", want: true},
		{name: "yaml false wins", yaml: &no, want: false},
		{name: "env beats yaml", yaml: &no, env: "true", want: true},
		{name: "flag beats env", yaml: &no, env: "true", cmdline: []string{"--2fa=false"}, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("DEVDECK_2FA", tt.env)
			cfg := &config.Config{Auth: config.AuthConfig{TwoFA: tt.yaml}}
			fs := flag.NewFlagSet("devdeck", flag.ContinueOnError)
			fs.SetOutput(io.Discard)
			twoFA := fs.Bool("2fa", envBool("DEVDECK_2FA", config.PickBool(cfg.Auth.TwoFA, true)), "")
			if err := fs.Parse(tt.cmdline); err != nil {
				t.Fatalf("parse: %v", err)
			}
			if *twoFA != tt.want {
				t.Errorf("2fa = %v, want %v", *twoFA, tt.want)
			}
		})
	}
}

// The list-valued flags keep their comma-separated wire format; JoinList is
// the only adapter between the YAML list and the existing parser.
func TestListFlagPrecedence(t *testing.T) {
	t.Setenv("DEVDECK_ONLY_FROM", "")
	cfg := &config.Config{Network: config.NetworkConfig{OnlyFrom: []string{"10.0.0.0/8", "100.64.0.0/10"}}}
	fs := flag.NewFlagSet("devdeck", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	onlyFrom := fs.String("only-from", envOr("DEVDECK_ONLY_FROM", config.Pick(config.JoinList(cfg.Network.OnlyFrom), "")), "")
	if err := fs.Parse(nil); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if *onlyFrom != "10.0.0.0/8,100.64.0.0/10" {
		t.Errorf("only-from = %q, want %q", *onlyFrom, "10.0.0.0/8,100.64.0.0/10")
	}
}

// ---------------------------------------------------------------------------
// Regression guard: the Makefile's dev targets and the Tauri sidecar
// ---------------------------------------------------------------------------

// Every flag `make dev-hub`, `make dev-runtime` and the desktop sidecar pass
// must still parse and resolve to exactly what they did before devdeck.yaml
// existed. A config file is present here *and* ignored, because an explicit
// flag outranks it.
func TestKnownInvocationsStillResolve(t *testing.T) {
	cfg := &config.Config{
		Role: "runtime",
		Addr: "0.0.0.0:9199",
		DB:   "yaml.db",
	}

	tests := []struct {
		name     string
		cmdline  []string
		wantRole string
		wantAddr string
		wantDB   string
	}{
		{
			name: "make dev-hub",
			cmdline: []string{
				"--role", "hub", "--key", "dev-hub-key", "--db", "devdeck.db",
				"--open=false", "--env", ".env", "--secure-cookies=false",
			},
			wantRole: "hub", wantAddr: "0.0.0.0:9199", wantDB: "devdeck.db",
		},
		{
			name: "make dev-runtime",
			cmdline: []string{
				"--role", "runtime", "--key", "dev-runtime-key", "--addr", "127.0.0.1:9199",
				"--db", "runtime.db", "--open=false", "--hub-url", "http://127.0.0.1:8989",
				"--hub-key", "dev-hub-key", "--public-url", "http://127.0.0.1:9199",
				"--name", "local-runtime",
			},
			wantRole: "runtime", wantAddr: "127.0.0.1:9199", wantDB: "runtime.db",
		},
		{
			name:     "tauri sidecar",
			cmdline:  []string{"--addr", "127.0.0.1:0", "--managed", "--open=false", "--secure-cookies=false"},
			wantRole: "runtime", wantAddr: "127.0.0.1:0", wantDB: "yaml.db",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, key := range []string{"DEVDECK_ROLE", "DEVDECK_ADDR", "DEVDECK_DB", "DEVDECK_KEY", "DEVDECK_HUB_URL", "DEVDECK_HUB_KEY", "DEVDECK_PUBLIC_URL", "DEVDECK_MACHINE_NAME", "DEVDECK_ENV_FILE", "DEVDECK_OPEN", "DEVDECK_SECURE_COOKIES", "DEVDECK_MANAGED"} {
				t.Setenv(key, "")
			}
			fs := flag.NewFlagSet("devdeck", flag.ContinueOnError)
			fs.SetOutput(io.Discard)
			role := fs.String("role", envOr("DEVDECK_ROLE", config.Pick(cfg.Role, "hub")), "")
			addr := fs.String("addr", envOr("DEVDECK_ADDR", config.Pick(cfg.Addr, "127.0.0.1:8989")), "")
			dbPath := fs.String("db", envOr("DEVDECK_DB", config.Pick(cfg.DB, "BUILTIN")), "")
			fs.String("key", "", "")
			fs.String("hub-url", "", "")
			fs.String("hub-key", "", "")
			fs.String("public-url", "", "")
			fs.String("name", "", "")
			fs.String("env", ".env", "")
			fs.Bool("open", true, "")
			fs.Bool("secure-cookies", true, "")
			fs.Bool("managed", false, "")
			if err := fs.Parse(tt.cmdline); err != nil {
				t.Fatalf("parse %q: %v", tt.cmdline, err)
			}
			if *role != tt.wantRole {
				t.Errorf("role = %q, want %q", *role, tt.wantRole)
			}
			if *addr != tt.wantAddr {
				t.Errorf("addr = %q, want %q", *addr, tt.wantAddr)
			}
			if *dbPath != tt.wantDB {
				t.Errorf("db = %q, want %q", *dbPath, tt.wantDB)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Writing the defaults file on a headless first boot
// ---------------------------------------------------------------------------

func TestWriteDefaultConfigRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "devdeck.yaml")
	if err := config.WriteDefaults(path); err != nil {
		t.Fatalf("WriteDefaults: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode = %v, want 0600", perm)
	}
	cfg, usedPath, err := config.Resolve(path)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if usedPath != path {
		t.Errorf("usedPath = %q, want %q", usedPath, path)
	}
	// The defaults file must resolve to the same values as no file at all.
	if got := config.Pick(cfg.Addr, "127.0.0.1:8989"); got != "127.0.0.1:8989" {
		t.Errorf("addr from defaults file = %q, want the built-in default", got)
	}
	if got := config.PickBool(cfg.Auth.TwoFA, true); !got {
		t.Errorf("two_fa from defaults file = %v, want true", got)
	}
}
