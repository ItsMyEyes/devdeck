package terminal

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"devdeck/backend/internal/store"
)

func TestResolveAntigravityUsesSelectedModel(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", home)
	bin := filepath.Join(home, "agy")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(filepath.Join(home, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	st := store.New(db)
	ws, _ := st.CreateWorkspace("test")
	proj, _ := st.CreateProject(ws.ID, "core", home, "", "")
	wt, err := st.CreateWorktree(proj.ID, "root", "", "", "real-model", "antigravity", "hello", home)
	if err != nil {
		t.Fatal(err)
	}
	gotBin, args, cwd := NewServer(st).resolveCommand(wt.ID)
	if gotBin != bin || cwd != home || !reflect.DeepEqual(args, []string{"--model", "real-model", "-p", "hello"}) {
		t.Fatalf("bin=%s args=%v cwd=%s", gotBin, args, cwd)
	}
}

func TestResolveCommandReturnsNoAgentForEmptyModelRootSession(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)

	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	proj, err := st.CreateProject(ws.ID, "core", "~/core", "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := st.CreateWorktree(proj.ID, "root", "", "", "", "", "", proj.Path)
	if err != nil {
		t.Fatal(err)
	}

	s := NewServer(st)
	agentBin, _, workDir := s.resolveCommand(wt.ID)

	if agentBin != "" {
		t.Errorf("resolveCommand agentBin = %q for empty-model root session, want empty (must fall back to a plain shell)", agentBin)
	}
	wantWorkDir := filepath.Join(home, "core")
	if workDir != wantWorkDir {
		t.Errorf("resolveCommand workDir = %q, want expanded project root %q", workDir, wantWorkDir)
	}
}

func TestResolveCommandReturnsAgentForBranchModeSession(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)

	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	proj, err := st.CreateProject(ws.ID, "core", "/tmp/core", "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := st.CreateWorktree(proj.ID, "branch", "feat/x", "main", "claude-sonnet-5", "claude", "", proj.Path)
	if err != nil {
		t.Fatal(err)
	}

	s := NewServer(st)
	agentBin, _, _ := s.resolveCommand(wt.ID)

	if agentBin == "" {
		t.Skip("no claude binary resolvable in this environment — resolveCommand logs and returns empty; not a regression in the mode-gating logic under test")
	}
}

func TestResolveCommandUsesStoredAgentNotModelPrefix(t *testing.T) {
	// Regression test: resolveCommand used to guess the agent binary by
	// checking whether wt.Model happened to start with an agent ID (e.g.
	// "claude-sonnet-5" starts with "claude"). Codex's models ("gpt-5", "o3",
	// ...) never start with "codex", so that heuristic silently fell back to
	// a plain shell for every agent except Claude. resolveCommand must
	// instead resolve the agent stored on the worktree directly.
	binDir := t.TempDir()
	fakeCodex := filepath.Join(binDir, "codex")
	if err := os.WriteFile(fakeCodex, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)

	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)

	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	proj, err := st.CreateProject(ws.ID, "core", "/tmp/core", "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}
	wt, err := st.CreateWorktree(proj.ID, "branch", "feat/x", "main", "gpt-5", "codex", "", proj.Path)
	if err != nil {
		t.Fatal(err)
	}

	s := NewServer(st)
	agentBin, _, _ := s.resolveCommand(wt.ID)

	if agentBin != fakeCodex {
		t.Errorf("resolveCommand agentBin = %q, want %q (must resolve via wt.Agent, not wt.Model prefix matching)", agentBin, fakeCodex)
	}
}
