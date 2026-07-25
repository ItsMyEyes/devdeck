package lsp

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
)

func stubInstallSpecs(t *testing.T, specs map[string]installSpec) {
	t.Helper()
	orig := installSpecs
	installSpecs = specs
	t.Cleanup(func() { installSpecs = orig })
}

func stubRunInstallCommand(t *testing.T, fn func(ctx context.Context, prereqPath string, args []string) error) {
	t.Helper()
	orig := runInstallCommand
	runInstallCommand = fn
	t.Cleanup(func() { runInstallCommand = orig })
}

func TestEnsureInstalledSkipsWhenAlreadyResolvable(t *testing.T) {
	binDir := t.TempDir()
	binPath := filepath.Join(binDir, "devdeck-test-already-there")
	if err := os.WriteFile(binPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)

	var calls int32
	stubRunInstallCommand(t, func(ctx context.Context, prereqPath string, args []string) error {
		atomic.AddInt32(&calls, 1)
		return nil
	})

	installer := NewInstaller()
	if err := installer.EnsureInstalled(context.Background(), "devdeck-test-already-there", nil); err != nil {
		t.Fatalf("EnsureInstalled returned error: %v", err)
	}
	if calls != 0 {
		t.Errorf("install command invoked %d times, want 0 (binary was already resolvable)", calls)
	}
}

func TestEnsureInstalledInstallsWhenMissingThenSucceeds(t *testing.T) {
	binDir := t.TempDir()
	prereqPath := filepath.Join(binDir, "fake-prereq")
	if err := os.WriteFile(prereqPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)

	stubInstallSpecs(t, map[string]installSpec{
		"fake-target": {prereq: "fake-prereq", args: []string{"install", "fake-target"}},
	})

	var gotPrereqPath string
	var gotArgs []string
	stubRunInstallCommand(t, func(ctx context.Context, resolvedPrereqPath string, args []string) error {
		gotPrereqPath = resolvedPrereqPath
		gotArgs = args
		return os.WriteFile(filepath.Join(binDir, "fake-target"), []byte("#!/bin/sh\n"), 0o755)
	})

	installer := NewInstaller()
	var installingCalls int
	err := installer.EnsureInstalled(context.Background(), "fake-target", func() { installingCalls++ })
	if err != nil {
		t.Fatalf("EnsureInstalled returned error: %v", err)
	}
	if installingCalls != 1 {
		t.Errorf("onInstalling called %d times, want 1", installingCalls)
	}
	if gotPrereqPath != prereqPath {
		t.Errorf("runInstallCommand prereq path = %q, want %q", gotPrereqPath, prereqPath)
	}
	wantArgs := []string{"install", "fake-target"}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Errorf("install args = %v, want %v", gotArgs, wantArgs)
	}
}

func TestEnsureInstalledDedupsConcurrentCallsForSameBinary(t *testing.T) {
	binDir := t.TempDir()
	prereqPath := filepath.Join(binDir, "fake-prereq")
	if err := os.WriteFile(prereqPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)

	stubInstallSpecs(t, map[string]installSpec{
		"fake-target": {prereq: "fake-prereq", args: []string{"install"}},
	})

	started := make(chan struct{})
	release := make(chan struct{})
	var installCount int32
	stubRunInstallCommand(t, func(ctx context.Context, prereqPath string, args []string) error {
		atomic.AddInt32(&installCount, 1)
		close(started)
		<-release
		return os.WriteFile(filepath.Join(binDir, "fake-target"), []byte("#!/bin/sh\n"), 0o755)
	})

	installer := NewInstaller()
	var wg sync.WaitGroup
	results := make([]error, 3)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = installer.EnsureInstalled(context.Background(), "fake-target", nil)
		}(i)
	}

	<-started
	close(release)
	wg.Wait()

	for i, err := range results {
		if err != nil {
			t.Errorf("caller %d: EnsureInstalled returned error: %v", i, err)
		}
	}
	if got := atomic.LoadInt32(&installCount); got != 1 {
		t.Errorf("install command invoked %d times, want 1 (concurrent calls should dedup)", got)
	}
}

func TestEnsureInstalledRejectsWhenUnsupportedOnCurrentOS(t *testing.T) {
	stubInstallSpecs(t, map[string]installSpec{
		"devdeck-test-unsupported": {
			prereq:    "fake-prereq",
			args:      []string{"install"},
			supported: func() bool { return false },
		},
	})

	installer := NewInstaller()
	if err := installer.EnsureInstalled(context.Background(), "devdeck-test-unsupported", nil); err == nil {
		t.Error("EnsureInstalled expected error for an unsupported-OS binary, got nil")
	}
}

func TestEnsureInstalledErrorsWhenPrereqMissing(t *testing.T) {
	stubInstallSpecs(t, map[string]installSpec{
		"devdeck-test-target": {prereq: "devdeck-test-nonexistent-prereq-xyz", args: []string{"install"}},
	})

	installer := NewInstaller()
	if err := installer.EnsureInstalled(context.Background(), "devdeck-test-target", nil); err == nil {
		t.Error("EnsureInstalled expected error when the prerequisite tool is missing, got nil")
	}
}

func TestEnsureInstalledErrorsWhenNoStrategyExists(t *testing.T) {
	installer := NewInstaller()
	err := installer.EnsureInstalled(context.Background(), "devdeck-test-unknown-binary-xyz", nil)
	if err == nil {
		t.Fatal("EnsureInstalled expected error for a binary with no install strategy, got nil")
	}
}
