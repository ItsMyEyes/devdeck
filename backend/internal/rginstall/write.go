package rginstall

import (
	"fmt"
	"os"
	"path/filepath"
)

// writeExecutable atomically writes data to path — mirroring
// selfupdate.ReplaceSelf's temp-file-write + chmod 0o755 + os.Rename-into-
// place pattern (write to a temp file in the destination directory, close
// it, mark it executable, then rename into place so a reader never
// observes a partially-written file), analogous rather than reused since
// ReplaceSelf specifically targets the currently-running executable. The
// destination directory is created if missing.
func writeExecutable(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create install directory: %w", err)
	}

	tmp, err := os.CreateTemp(dir, ".rg-install-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()

	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("write ripgrep binary: %w", writeErr)
	}
	if closeErr != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close temp file: %w", closeErr)
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("chmod ripgrep binary: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("move ripgrep binary into place: %w", err)
	}
	return nil
}
