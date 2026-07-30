package version

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"sync"
)

var (
	selfHashOnce sync.Once
	selfHash     string
	selfHashErr  error
)

// SelfSHA256 returns the lowercase hex SHA-256 of the executable this process
// is running, so the operator can match a deployed binary against the digest
// its release published in checksums.txt.
//
// The digest is computed on first call rather than at startup — a ~60MB binary
// costs ~100ms to hash, and most runs never ask for it — then cached for the
// process lifetime. Caching is also what makes the answer correct across a
// self-update: replacing the binary swaps the directory entry while this
// process keeps executing the old inode, so the first digest keeps describing
// the code actually running until someone restarts.
func SelfSHA256() (string, error) {
	selfHashOnce.Do(func() {
		exe, err := os.Executable()
		if err != nil {
			selfHashErr = fmt.Errorf("resolve executable path: %w", err)
			return
		}
		selfHash, selfHashErr = hashFile(exe)
	})
	return selfHash, selfHashErr
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
