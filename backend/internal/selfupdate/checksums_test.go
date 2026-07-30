package selfupdate

import (
	"errors"
	"strings"
	"testing"
)

// Real sha256sum output shape: "<hex>  <name>" (two spaces), with a "*"
// prefix on the name in binary mode.
const manifest = `
9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  devdeck-runtime-linux-amd64
ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad *devdeck-runtime-windows-amd64.exe
not-a-valid-line
`

func TestChecksumForFindsTheNamedEntry(t *testing.T) {
	got, err := ChecksumFor([]byte(manifest), "devdeck-runtime-linux-amd64")
	if err != nil {
		t.Fatalf("ChecksumFor() error = %v", err)
	}
	want := "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
	if got != want {
		t.Errorf("ChecksumFor() = %q, want %q", got, want)
	}
}

func TestChecksumForStripsBinaryModeStar(t *testing.T) {
	got, err := ChecksumFor([]byte(manifest), "devdeck-runtime-windows-amd64.exe")
	if err != nil {
		t.Fatalf("ChecksumFor() error = %v", err)
	}
	want := "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got != want {
		t.Errorf("ChecksumFor() = %q, want %q", got, want)
	}
}

func TestChecksumForReportsAMissingName(t *testing.T) {
	_, err := ChecksumFor([]byte(manifest), "devdeck-runtime-darwin-arm64")
	if !errors.Is(err, ErrChecksumNotListed) {
		t.Fatalf("ChecksumFor() error = %v, want ErrChecksumNotListed", err)
	}
	if !strings.Contains(err.Error(), "devdeck-runtime-darwin-arm64") {
		t.Errorf("error %q should name the asset it looked for", err)
	}
}

func TestVerifySHA256AcceptsAMatch(t *testing.T) {
	// sha256("abc")
	if err := VerifySHA256([]byte("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); err != nil {
		t.Fatalf("VerifySHA256() error = %v, want nil", err)
	}
}

func TestVerifySHA256IsCaseInsensitive(t *testing.T) {
	if err := VerifySHA256([]byte("abc"), "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"); err != nil {
		t.Fatalf("VerifySHA256() error = %v, want nil for an uppercase digest", err)
	}
}

func TestVerifySHA256RejectsAMismatchAndNamesBothDigests(t *testing.T) {
	want := "0000000000000000000000000000000000000000000000000000000000000000"
	err := VerifySHA256([]byte("abc"), want)
	if err == nil {
		t.Fatal("VerifySHA256() error = nil, want non-nil for a mismatched digest")
	}
	if !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), "ba7816bf") {
		t.Errorf("error %q should name both the expected and the actual digest", err)
	}
}
