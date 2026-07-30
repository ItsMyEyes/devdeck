package selfupdate

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// ChecksumsFileName is the sha256 manifest published alongside the binaries by
// .github/workflows/release.yml (`sha256sum devdeck-runtime-* > checksums.txt`).
const ChecksumsFileName = "checksums.txt"

// ErrChecksumNotListed means the manifest parsed fine but has no entry for the
// requested asset — distinct from "the release has no manifest at all", which
// callers treat as a warning rather than a failure.
var ErrChecksumNotListed = errors.New("asset not listed in the checksum manifest")

// ChecksumFor returns the hex digest recorded for name in a sha256sum-format
// manifest. Lines are "<hex>  <name>", with an optional "*" prefix on the name
// in binary mode. Malformed and blank lines are skipped rather than fatal — a
// future release could add a header line without breaking updates.
func ChecksumFor(manifest []byte, name string) (string, error) {
	scanner := bufio.NewScanner(bytes.NewReader(manifest))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 {
			continue
		}
		if strings.TrimPrefix(fields[1], "*") == name {
			return strings.ToLower(fields[0]), nil
		}
	}
	return "", fmt.Errorf("%w: %s", ErrChecksumNotListed, name)
}

// VerifySHA256 reports whether data hashes to wantHex, naming both digests on
// mismatch so a failure says what was expected and what arrived.
func VerifySHA256(data []byte, wantHex string) error {
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, wantHex) {
		return fmt.Errorf("checksum mismatch: got %s, want %s", got, strings.ToLower(wantHex))
	}
	return nil
}
