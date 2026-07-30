package version

import (
	"os"
	"path/filepath"
	"testing"
)

// Known-answer vectors from the SHA-256 spec, so the test proves we hash
// correctly rather than just agreeing with ourselves.
const (
	emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	abcDigest   = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
)

func TestHashFileMatchesKnownDigests(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name     string
		contents string
		want     string
	}{
		{"empty file", "", emptyDigest},
		{"abc", "abc", abcDigest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name)
			if err := os.WriteFile(path, []byte(tc.contents), 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := hashFile(path)
			if err != nil {
				t.Fatalf("hashFile() error = %v", err)
			}
			if got != tc.want {
				t.Errorf("hashFile() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestHashFileErrorsOnMissingFile(t *testing.T) {
	if _, err := hashFile(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("hashFile() error = nil, want non-nil for a missing file")
	}
}

func TestSelfSHA256IsStableAcrossCalls(t *testing.T) {
	first, err := SelfSHA256()
	if err != nil {
		t.Fatalf("SelfSHA256() error = %v", err)
	}
	if len(first) != 64 {
		t.Fatalf("SelfSHA256() = %q, want 64 hex chars", first)
	}
	second, err := SelfSHA256()
	if err != nil {
		t.Fatalf("second SelfSHA256() error = %v", err)
	}
	if second != first {
		t.Errorf("SelfSHA256() returned %q then %q, want a stable cached value", first, second)
	}
}
