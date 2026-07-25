package rginstall

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"testing"
)

// buildTestTarGz builds an in-memory .tar.gz with the given entries
// (path -> content), mirroring the nested-subdirectory layout ripgrep's
// real release archives use (e.g. "ripgrep-<version>-<target>/rg").
func buildTestTarGz(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, content := range entries {
		hdr := &tar.Header{Name: name, Mode: 0o755, Size: int64(len(content))}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// buildTestZip builds an in-memory .zip with the given entries, mirroring
// ripgrep's Windows release archive layout.
func buildTestZip(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtractBinaryFromTarGzFindsNestedRgBinary(t *testing.T) {
	data := buildTestTarGz(t, map[string]string{
		"ripgrep-15.2.0-x86_64-apple-darwin/rg":               "fake-rg-binary-contents",
		"ripgrep-15.2.0-x86_64-apple-darwin/README.md":        "not the binary",
		"ripgrep-15.2.0-x86_64-apple-darwin/complete/rg.bash": "not the binary either",
	})
	got, err := extractBinary("ripgrep-15.2.0-x86_64-apple-darwin.tar.gz", data, "darwin")
	if err != nil {
		t.Fatalf("extractBinary failed: %v", err)
	}
	if string(got) != "fake-rg-binary-contents" {
		t.Errorf("got %q, want the rg binary's contents", got)
	}
}

func TestExtractBinaryFromZipFindsNestedRgExe(t *testing.T) {
	data := buildTestZip(t, map[string]string{
		"ripgrep-15.2.0-x86_64-pc-windows-msvc/rg.exe":    "fake-rg-exe-contents",
		"ripgrep-15.2.0-x86_64-pc-windows-msvc/README.md": "not the binary",
	})
	got, err := extractBinary("ripgrep-15.2.0-x86_64-pc-windows-msvc.zip", data, "windows")
	if err != nil {
		t.Fatalf("extractBinary failed: %v", err)
	}
	if string(got) != "fake-rg-exe-contents" {
		t.Errorf("got %q, want the rg.exe binary's contents", got)
	}
}

func TestExtractBinaryErrorsWhenBinaryMissingFromArchive(t *testing.T) {
	data := buildTestTarGz(t, map[string]string{"ripgrep-15.2.0/README.md": "no binary here"})
	if _, err := extractBinary("ripgrep-15.2.0-x86_64-apple-darwin.tar.gz", data, "darwin"); err == nil {
		t.Fatal("expected an error when the archive has no rg binary, got nil")
	}
}

func TestExtractBinaryErrorsOnUnrecognizedArchiveFormat(t *testing.T) {
	if _, err := extractBinary("ripgrep-15.2.0.tar.xz", []byte("whatever"), "linux"); err == nil {
		t.Fatal("expected an error for an unrecognized archive extension, got nil")
	}
}
