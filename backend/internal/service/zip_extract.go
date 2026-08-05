package service

import (
	"archive/zip"
	"fmt"
	"os"
	"strings"
)

// extractPlanEntry is one already-validated zip entry, generic across
// extraction targets (a local worktree checkout vs. a remote SFTP
// filesystem): its archive name has been normalized and bounds-checked
// (normalizeRelativePath — the same "no .., no absolute paths" contract this
// package applies everywhere else) and its type verified (symlink entries
// rejected outright; everything else must be a regular file or a
// directory). It carries no notion of where it will ultimately be written —
// that step is target-specific (a local join + symlink-escape check via
// ensureInside vs. an SFTP path.Join against a connection's home directory)
// and stays with each caller.
type extractPlanEntry struct {
	zipFile  *zip.File
	relative string
	isDir    bool
}

// planZipExtraction validates every entry in files before a caller writes
// any of them: symlink entries and other non-regular/non-directory types are
// rejected outright, the running uncompressed total is checked against
// maxExtractUncompressedBytes using the zip's own declared sizes (no entry
// is decompressed just to plan the write), and each entry's name is cleaned
// and bounds-checked via normalizeRelativePath — rejecting ".." segments and
// absolute paths before a single byte is written, so a rejected archive can
// never leave a partially-extracted destination behind.
//
// This is the entry-validation core SSHFileService.Extract calls directly,
// and WorktreeFileService.Extract's planExtraction delegates to it before
// layering on its own on-disk resolution (rejectReservedPath, filepath.Join,
// ensureInside) — so the entry-type and path-normalization checks live in
// exactly one place and hardening either target hardens both.
func planZipExtraction(files []*zip.File) ([]extractPlanEntry, error) {
	plan := make([]extractPlanEntry, 0, len(files))
	var totalUncompressed uint64
	for _, zf := range files {
		mode := zf.Mode()
		if mode&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("archive entry %q is a symlink: %w", zf.Name, ErrValidation)
		}
		isDir := mode.IsDir() || strings.HasSuffix(zf.Name, "/")
		if !isDir && !mode.IsRegular() {
			return nil, fmt.Errorf("archive entry %q is not a regular file: %w", zf.Name, ErrValidation)
		}

		totalUncompressed += zf.UncompressedSize64
		if totalUncompressed > maxExtractUncompressedBytes {
			return nil, fmt.Errorf(
				"archive exceeds the %d MB uncompressed limit: %w",
				maxExtractUncompressedBytes/(1<<20),
				ErrValidation,
			)
		}

		relative, err := normalizeRelativePath(zf.Name, false)
		if err != nil {
			return nil, fmt.Errorf("archive entry %q: %w", zf.Name, err)
		}

		plan = append(plan, extractPlanEntry{zipFile: zf, relative: relative, isDir: isDir})
	}
	return plan, nil
}
