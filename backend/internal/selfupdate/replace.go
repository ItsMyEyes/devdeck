package selfupdate

import (
	"fmt"
	"os"
	"path/filepath"
)

// ReplaceSelf atomically swaps the binary at execPath with data. On unix,
// os.Rename over the currently-executing file is safe — the running process
// keeps its old inode open, and the new file is what the next invocation
// sees. On windows, a running .exe can't be overwritten directly, so the
// current file is renamed aside first and best-effort cleaned up after.
//
// goos is passed explicitly (rather than read from runtime.GOOS) so both
// code paths are exercised in tests regardless of the host running them.
func ReplaceSelf(goos, execPath string, data []byte) error {
	dir := filepath.Dir(execPath)
	tmp, err := os.CreateTemp(dir, ".loom-update-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()

	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("write downloaded binary: %w", writeErr)
	}
	if closeErr != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close temp file: %w", closeErr)
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("chmod downloaded binary: %w", err)
	}

	if goos == "windows" {
		oldPath := execPath + ".old"
		os.Remove(oldPath) // best-effort: drop a leftover from a previous update
		if err := os.Rename(execPath, oldPath); err != nil {
			os.Remove(tmpPath)
			return fmt.Errorf("rename current binary aside: %w", err)
		}
		if err := os.Rename(tmpPath, execPath); err != nil {
			return fmt.Errorf("move new binary into place: %w", err)
		}
		os.Remove(oldPath) // best-effort cleanup; ignored if still locked
		return nil
	}

	if err := os.Rename(tmpPath, execPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("replace current binary: %w", err)
	}
	return nil
}
