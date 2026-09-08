package registry

import (
	"os"
	"path/filepath"
	"testing"
)

// Regression test for the bug where a CLI installed (or PATH-fixed) AFTER
// the backend process started stayed invisible for the rest of that
// process's life: installed used to be a map computed once in
// NewLocalRegistry via detect.ProbeAll() and never touched again, so
// ListSkills kept returning the hardcoded static catalog forever instead of
// ever reading the agent's real ~/.claude, ~/.codex, or ~/.agents/skills
// directory — the chat skill list silently diverged from what was actually
// installed. installed is now a live check on every call; this proves it.
func TestLocalRegistryInstalledIsCheckedLiveNotFrozenAtConstruction(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", filepath.Join(home, "empty")) // nothing resolvable yet

	reg := NewLocalRegistry(NewStaticRegistry())
	if reg.installed("claude") {
		t.Fatal(`installed("claude") = true before the CLI exists anywhere on PATH`)
	}

	// Simulate installing the CLI (or fixing PATH) while the backend is
	// already running — this must not require reconstructing the registry.
	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "claude"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)

	if !reg.installed("claude") {
		t.Fatal(`installed("claude") is still false after the CLI was added to PATH — installed state is frozen at construction time, not checked live`)
	}
}
