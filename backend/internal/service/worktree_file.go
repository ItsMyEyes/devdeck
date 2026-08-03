package service

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"devdeck/backend/internal/detect"
	gitpkg "devdeck/backend/internal/git"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/rginstall"
	"devdeck/backend/internal/store"
)

const (
	maxEditableFileSize  = 2 << 20
	maxFileSearchResults = 200

	// maxGrepFiles/maxGrepMatchesPerFile bound a content-search response,
	// same spirit as maxFileSearchResults for filename search — exact
	// numbers are an implementation detail, not a design commitment.
	maxGrepFiles          = 200
	maxGrepMatchesPerFile = 200

	// grepTimeout bounds how long a local `rg` invocation may run before
	// being killed, so a huge/slow tree can't hang a request.
	grepTimeout = 20 * time.Second

	// rgInstallTimeout bounds how long a ripgrep auto-install (GitHub API
	// call + asset download + extract + write) may run before being
	// canceled, so a slow/stalled network request can't hang a request
	// indefinitely.
	rgInstallTimeout = 60 * time.Second
)

var searchSkipDirs = map[string]bool{
	".git":         true,
	".wt":          true,
	".codegraph":   true,
	".next":        true,
	"build":        true,
	"dist":         true,
	"node_modules": true,
	"vendor":       true,
}

// WorktreeFileEntry is one visible item in a worktree directory.
type WorktreeFileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

// WorktreeFileContent is the editable text representation of a worktree file.
type WorktreeFileContent struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// WorktreeUploadFile is one multipart upload stream destined for a worktree folder.
type WorktreeUploadFile struct {
	Name   string
	Reader io.Reader
}

// WorktreeFileService provides file access rooted strictly inside one
// worktree. It never accepts absolute paths or paths containing "..".
type WorktreeFileService struct {
	store port.Store
}

func NewWorktreeFileService(s port.Store) *WorktreeFileService {
	return &WorktreeFileService{store: s}
}

func (svc *WorktreeFileService) List(worktreeID, relativePath string) ([]WorktreeFileEntry, error) {
	_, target, clean, err := svc.resolve(worktreeID, relativePath, true, false)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, fileOperationError("read folder", clean, err)
	}

	result := make([]WorktreeFileEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.Name() == ".git" || entry.Name() == ".wt" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		size := int64(0)
		if !entry.IsDir() {
			size = info.Size()
		}
		result = append(result, WorktreeFileEntry{
			Name:  entry.Name(),
			Path:  path.Join(clean, entry.Name()),
			IsDir: entry.IsDir(),
			Size:  size,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})
	return result, nil
}

func (svc *WorktreeFileService) Read(worktreeID, relativePath string) (WorktreeFileContent, error) {
	_, target, clean, err := svc.resolve(worktreeID, relativePath, false, false)
	if err != nil {
		return WorktreeFileContent{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return WorktreeFileContent{}, fileOperationError("read file", clean, err)
	}
	if info.IsDir() {
		return WorktreeFileContent{}, fmt.Errorf("%q is a folder: %w", clean, ErrValidation)
	}
	if info.Size() > maxEditableFileSize {
		return WorktreeFileContent{}, fmt.Errorf(
			"%q is larger than the %d MB editor limit: %w",
			clean,
			maxEditableFileSize/(1<<20),
			ErrValidation,
		)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return WorktreeFileContent{}, fileOperationError("read file", clean, err)
	}
	if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return WorktreeFileContent{}, fmt.Errorf("%q is not a UTF-8 text file: %w", clean, ErrValidation)
	}
	return WorktreeFileContent{Path: clean, Content: string(data)}, nil
}

// Download opens a worktree file for raw byte-for-byte transfer. It shares
// Read's path validation (svc.resolve, including symlink-escape rejection)
// but deliberately applies neither maxEditableFileSize nor the UTF-8/NUL
// check: those exist to protect the editor, and a download has neither
// constraint — this is what makes binary and oversized files retrievable at
// all. Directories are rejected; they go through Archive instead. The caller
// owns the returned handle and must close it.
func (svc *WorktreeFileService) Download(worktreeID, relativePath string) (*os.File, os.FileInfo, string, error) {
	_, target, clean, err := svc.resolve(worktreeID, relativePath, false, false)
	if err != nil {
		return nil, nil, "", err
	}
	// Archive applies this via resolveSelection; without it here, Download
	// would be the one route that serves .git/.wt bytes (credentials in
	// .git/config, packfiles, sibling worktrees) that List never even shows.
	if err := rejectReservedPath(clean, false); err != nil {
		return nil, nil, "", err
	}
	info, err := os.Stat(target)
	if err != nil {
		return nil, nil, "", fileOperationError("read file", clean, err)
	}
	if info.IsDir() {
		return nil, nil, "", fmt.Errorf("%q is a folder — use zip to download folders: %w", clean, ErrValidation)
	}
	// os.Open on a FIFO blocks until a writer appears, and the server sets no
	// WriteTimeout, so anything but a regular file would park the handler
	// goroutine for the process lifetime.
	if !info.Mode().IsRegular() {
		return nil, nil, "", fmt.Errorf("%q is not a regular file: %w", clean, ErrValidation)
	}
	file, err := os.Open(target)
	if err != nil {
		return nil, nil, "", fileOperationError("read file", clean, err)
	}
	return file, info, clean, nil
}

func (svc *WorktreeFileService) Write(worktreeID, relativePath, content string) (WorktreeFileContent, error) {
	if len(content) > maxEditableFileSize {
		return WorktreeFileContent{}, fmt.Errorf(
			"content is larger than the %d MB editor limit: %w",
			maxEditableFileSize/(1<<20),
			ErrValidation,
		)
	}
	_, target, clean, err := svc.resolve(worktreeID, relativePath, false, true)
	if err != nil {
		return WorktreeFileContent{}, err
	}

	mode := fs.FileMode(0o644)
	if info, statErr := os.Stat(target); statErr == nil {
		if info.IsDir() {
			return WorktreeFileContent{}, fmt.Errorf("%q is a folder: %w", clean, ErrValidation)
		}
		mode = info.Mode().Perm()
	} else if !os.IsNotExist(statErr) {
		return WorktreeFileContent{}, fileOperationError("inspect file", clean, statErr)
	}

	if err := os.WriteFile(target, []byte(content), mode); err != nil {
		return WorktreeFileContent{}, fileOperationError("write file", clean, err)
	}
	return WorktreeFileContent{Path: clean, Content: content}, nil
}

// Mkdir creates an empty folder. Unlike Write (which only ever creates the
// file itself, not missing parents), this uses MkdirAll so "New Folder"
// works the same one level deep as nested — the resolve(allowMissing=true)
// call below still requires the immediate parent to already exist, matching
// Write's existing contract.
func (svc *WorktreeFileService) Mkdir(worktreeID, relativePath string) (WorktreeFileEntry, error) {
	_, target, clean, err := svc.resolve(worktreeID, relativePath, false, true)
	if err != nil {
		return WorktreeFileEntry{}, err
	}
	if err := rejectReservedPath(clean, false); err != nil {
		return WorktreeFileEntry{}, err
	}
	if _, statErr := os.Stat(target); statErr == nil {
		return WorktreeFileEntry{}, fmt.Errorf("%q already exists: %w", clean, ErrConflict)
	} else if !os.IsNotExist(statErr) {
		return WorktreeFileEntry{}, fileOperationError("inspect folder", clean, statErr)
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return WorktreeFileEntry{}, fileOperationError("create folder", clean, err)
	}
	return WorktreeFileEntry{Name: path.Base(clean), Path: clean, IsDir: true}, nil
}

// Move renames or relocates a file/folder within the worktree — the single
// primitive backing both the file tree's "Rename" (same parent, new name)
// and "Cut" + "Paste" (new parent, same or new name). Refuses to clobber an
// existing destination (ErrConflict) rather than silently overwriting, and
// refuses to move a folder into itself or one of its own descendants.
func (svc *WorktreeFileService) Move(worktreeID, fromPath, toPath string) (WorktreeFileEntry, error) {
	_, fromTarget, fromClean, err := svc.resolve(worktreeID, fromPath, false, false)
	if err != nil {
		return WorktreeFileEntry{}, err
	}
	if err := rejectReservedPath(fromClean, false); err != nil {
		return WorktreeFileEntry{}, err
	}
	_, toTarget, toClean, err := svc.resolve(worktreeID, toPath, false, true)
	if err != nil {
		return WorktreeFileEntry{}, err
	}
	if err := rejectReservedPath(toClean, false); err != nil {
		return WorktreeFileEntry{}, err
	}
	if toClean == fromClean {
		return WorktreeFileEntry{}, fmt.Errorf("source and destination are the same: %w", ErrValidation)
	}
	if strings.HasPrefix(toClean, fromClean+"/") {
		return WorktreeFileEntry{}, fmt.Errorf("cannot move %q into itself: %w", fromClean, ErrValidation)
	}
	info, err := os.Lstat(fromTarget)
	if err != nil {
		return WorktreeFileEntry{}, fileOperationError("inspect file", fromClean, err)
	}
	if _, statErr := os.Lstat(toTarget); statErr == nil {
		return WorktreeFileEntry{}, fmt.Errorf("%q already exists: %w", toClean, ErrConflict)
	} else if !os.IsNotExist(statErr) {
		return WorktreeFileEntry{}, fileOperationError("inspect file", toClean, statErr)
	}
	if err := os.Rename(fromTarget, toTarget); err != nil {
		return WorktreeFileEntry{}, fileOperationError("move file", fromClean, err)
	}
	return WorktreeFileEntry{Name: path.Base(toClean), Path: toClean, IsDir: info.IsDir()}, nil
}

// Copy duplicates a file or folder (recursively) to a new path — backs the
// file tree's "Copy" + "Paste". Same conflict/self-nesting rules as Move.
func (svc *WorktreeFileService) Copy(worktreeID, fromPath, toPath string) (WorktreeFileEntry, error) {
	_, fromTarget, fromClean, err := svc.resolve(worktreeID, fromPath, false, false)
	if err != nil {
		return WorktreeFileEntry{}, err
	}
	if err := rejectReservedPath(fromClean, false); err != nil {
		return WorktreeFileEntry{}, err
	}
	_, toTarget, toClean, err := svc.resolve(worktreeID, toPath, false, true)
	if err != nil {
		return WorktreeFileEntry{}, err
	}
	if err := rejectReservedPath(toClean, false); err != nil {
		return WorktreeFileEntry{}, err
	}
	if toClean == fromClean {
		return WorktreeFileEntry{}, fmt.Errorf("source and destination are the same: %w", ErrValidation)
	}
	if strings.HasPrefix(toClean, fromClean+"/") {
		return WorktreeFileEntry{}, fmt.Errorf("cannot copy %q into itself: %w", fromClean, ErrValidation)
	}
	info, err := os.Lstat(fromTarget)
	if err != nil {
		return WorktreeFileEntry{}, fileOperationError("inspect file", fromClean, err)
	}
	if _, statErr := os.Lstat(toTarget); statErr == nil {
		return WorktreeFileEntry{}, fmt.Errorf("%q already exists: %w", toClean, ErrConflict)
	} else if !os.IsNotExist(statErr) {
		return WorktreeFileEntry{}, fileOperationError("inspect file", toClean, statErr)
	}
	if info.IsDir() {
		if err := copyDirRecursive(fromTarget, toTarget); err != nil {
			return WorktreeFileEntry{}, fileOperationError("copy folder", fromClean, err)
		}
	} else if err := copyFileMode(fromTarget, toTarget, info.Mode()); err != nil {
		return WorktreeFileEntry{}, fileOperationError("copy file", fromClean, err)
	}
	return WorktreeFileEntry{Name: path.Base(toClean), Path: toClean, IsDir: info.IsDir()}, nil
}

func copyFileMode(from, to string, mode fs.FileMode) error {
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode.Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(dst, src)
	closeErr := dst.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func copyDirRecursive(from, to string) error {
	return filepath.WalkDir(from, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(from, current)
		if err != nil {
			return err
		}
		dest := filepath.Join(to, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(dest, info.Mode().Perm())
		}
		return copyFileMode(current, dest, info.Mode())
	})
}

func (svc *WorktreeFileService) Delete(worktreeID, relativePath string) error {
	_, target, clean, err := svc.resolve(worktreeID, relativePath, false, false)
	if err != nil {
		return err
	}
	if err := os.Remove(target); err != nil {
		if errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST) {
			return fmt.Errorf("%q is not empty: %w", clean, ErrConflict)
		}
		return fileOperationError("delete file", clean, err)
	}
	return nil
}

func (svc *WorktreeFileService) Upload(worktreeID, folderPath string, uploads []WorktreeUploadFile) ([]WorktreeFileEntry, error) {
	if len(uploads) == 0 {
		return nil, fmt.Errorf("at least one file is required: %w", ErrValidation)
	}
	root, targetDir, cleanDir, err := svc.resolve(worktreeID, folderPath, true, false)
	if err != nil {
		return nil, err
	}
	if err := rejectReservedPath(cleanDir, true); err != nil {
		return nil, err
	}
	info, err := os.Stat(targetDir)
	if err != nil {
		return nil, fileOperationError("inspect upload folder", cleanDir, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%q is not a folder: %w", cleanDir, ErrValidation)
	}

	entries := make([]WorktreeFileEntry, 0, len(uploads))
	for _, upload := range uploads {
		name, err := safeUploadName(upload.Name)
		if err != nil {
			return nil, err
		}
		cleanPath := path.Join(cleanDir, name)
		if err := rejectReservedPath(cleanPath, false); err != nil {
			return nil, err
		}
		target := filepath.Join(targetDir, filepath.FromSlash(name))
		if err := ensureInside(root, target); err != nil {
			return nil, err
		}
		if existing, err := os.Stat(target); err == nil && existing.IsDir() {
			return nil, fmt.Errorf("%q is a folder: %w", cleanPath, ErrValidation)
		} else if err != nil && !os.IsNotExist(err) {
			return nil, fileOperationError("inspect upload target", cleanPath, err)
		}

		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return nil, fileOperationError("write upload", cleanPath, err)
		}
		_, copyErr := io.Copy(out, upload.Reader)
		closeErr := out.Close()
		if copyErr != nil {
			return nil, fileOperationError("write upload", cleanPath, copyErr)
		}
		if closeErr != nil {
			return nil, fileOperationError("write upload", cleanPath, closeErr)
		}
		info, err := os.Stat(target)
		if err != nil {
			return nil, fileOperationError("inspect upload", cleanPath, err)
		}
		entries = append(entries, WorktreeFileEntry{Name: name, Path: cleanPath, IsDir: false, Size: info.Size()})
	}
	return entries, nil
}

func (svc *WorktreeFileService) DeleteMany(worktreeID string, paths []string) error {
	selection, err := svc.resolveSelection(worktreeID, paths)
	if err != nil {
		return err
	}
	for _, item := range selection {
		if err := os.RemoveAll(item.target); err != nil {
			return fileOperationError("delete file", item.clean, err)
		}
	}
	return nil
}

func (svc *WorktreeFileService) Archive(worktreeID string, paths []string, dst io.Writer) error {
	selection, err := svc.resolveSelection(worktreeID, paths)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(dst)
	seen := make(map[string]bool)
	for _, item := range selection {
		if err := addPathToZip(zw, item, seen); err != nil {
			_ = zw.Close()
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("zip selection failed")
	}
	return nil
}

// Search returns relative file paths matched by regex syntax or forgiving
// case-insensitive path search. Directory matches are returned with a trailing
// slash when includeDirs is true.
func (svc *WorktreeFileService) Search(worktreeID, pattern string, includeDirs bool) ([]string, error) {
	root, _, _, err := svc.resolve(worktreeID, "", true, false)
	if err != nil {
		return nil, err
	}

	matcher := newFilePathMatcher(pattern)
	matches := make([]fileSearchMatch, 0)
	err = filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, fs.ErrPermission) {
				return nil
			}
			return walkErr
		}
		if current == root {
			return nil
		}
		if entry.IsDir() && searchSkipDirs[entry.Name()] {
			return filepath.SkipDir
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if entry.IsDir() {
			if includeDirs {
				addFileSearchMatch(&matches, matcher, relative+"/", true)
			}
			return nil
		}
		addFileSearchMatch(&matches, matcher, relative, false)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("search files failed")
	}

	sort.Slice(matches, func(i, j int) bool {
		if matches[i].score != matches[j].score {
			return matches[i].score < matches[j].score
		}
		return matches[i].path < matches[j].path
	})
	if len(matches) > maxFileSearchResults {
		matches = matches[:maxFileSearchResults]
	}
	result := make([]string, 0, len(matches))
	for _, match := range matches {
		result = append(result, match.path)
	}
	return result, nil
}

// GrepOptions configures a content search's query interpretation. Shared
// (same package) between WorktreeFileService.Grep and SSHFileService.Grep
// so the frontend has one request/response shape regardless of which
// search target (local worktree/Machine vs. SSH connection) it's hitting.
type GrepOptions struct {
	Regex          bool
	CaseSensitive  bool
	IncludePattern string
}

// GrepMatch is one matched line within a GrepFileMatch. Column is a 1-based
// offset into Text where the match starts (ripgrep's --json submatch
// "start" byte offset, +1).
type GrepMatch struct {
	Line   int    `json:"line"`
	Column int    `json:"column"`
	Text   string `json:"text"`
}

// GrepFileMatch groups every GrepMatch found in one file, path relative to
// the search root.
type GrepFileMatch struct {
	Path    string      `json:"path"`
	Matches []GrepMatch `json:"matches"`
}

// GrepResult is the shared response shape for both WorktreeFileService.Grep
// and SSHFileService.Grep. RgAvailable is false whenever ripgrep itself
// isn't installed on the target — reported back rather than treated as an
// error, so the frontend can offer a one-click ripgrep install (a later
// feature). This does not necessarily mean Files is empty: when rg is
// missing but a `grep` fallback is found (Engine: "grep"), Files still
// carries real results from that fallback; Files is only empty when neither
// engine is available.
type GrepResult struct {
	Engine      string          `json:"engine"`
	RgAvailable bool            `json:"rgAvailable"`
	Truncated   bool            `json:"truncated"`
	Files       []GrepFileMatch `json:"files"`
}

// resolveRipgrep resolves the "rg" binary via detect.ResolveBinary,
// overridable in tests — same pattern as detect's own shellPathDirs (see its
// doc comment: "overridable in tests via direct reassignment") — so Grep's
// "ripgrep not installed" path can be exercised deterministically
// regardless of whether the machine running the tests happens to have
// ripgrep installed under one of ResolveBinary's hardcoded fallback dirs
// (e.g. Homebrew's /opt/homebrew/bin on macOS), which plain PATH
// manipulation in a test can't hide.
var resolveRipgrep = func() (string, error) { return detect.ResolveBinary("rg") }

// resolveGrepBinary resolves the "grep" binary via detect.ResolveBinary,
// overridable in tests exactly like resolveRipgrep — used by
// WorktreeFileService.Grep's fallback path when ripgrep isn't installed.
var resolveGrepBinary = func() (string, error) { return detect.ResolveBinary("grep") }

// currentGOOS reports the local OS, overridable in tests via direct
// reassignment — same pattern as resolveRipgrep — so Grep's "no grep
// fallback on Windows" branch (design decision 5: Windows has no reliable
// built-in grep) can be exercised deterministically regardless of which OS
// actually runs the test suite.
var currentGOOS = runtime.GOOS

// currentGOARCH reports the local architecture, overridable in tests
// exactly like currentGOOS — used by InstallRipgrep to pick the right
// ripgrep release asset without depending on which arch actually runs the
// test suite.
var currentGOARCH = runtime.GOARCH

// installRipgrepLocal wraps rginstall.InstallLocal, overridable in tests
// via direct reassignment — same pattern as resolveRipgrep — so
// InstallRipgrep's tests don't require real network access.
var installRipgrepLocal = rginstall.InstallLocal

// Grep searches file contents under worktreeID's root using ripgrep, if
// installed (detected via detect.ResolveBinary, same helper internal/lsp
// uses for language-server binaries — handles the GUI/service process not
// seeing the login shell's PATH). When rg isn't resolvable and the local OS
// isn't Windows, it falls back to `grep -rn` (detected the same way); on
// Windows there is no reliable built-in grep (design decision 5), so the
// fallback is skipped there. If neither engine is available, this reports
// GrepResult{RgAvailable: false} with a nil error rather than failing the
// request.
func (svc *WorktreeFileService) Grep(ctx context.Context, worktreeID, query string, opts GrepOptions) (GrepResult, error) {
	if strings.TrimSpace(query) == "" {
		return GrepResult{}, fmt.Errorf("query is required: %w", ErrValidation)
	}
	root, _, _, err := svc.resolve(worktreeID, "", true, false)
	if err != nil {
		return GrepResult{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, grepTimeout)
	defer cancel()

	if rgPath, rgErr := resolveRipgrep(); rgErr == nil {
		cmd := exec.CommandContext(ctx, rgPath, rgGrepArgs(query, opts, root)...)
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		runErr := cmd.Run()
		if runErr != nil && !isLocalNoMatchExit(runErr) {
			return GrepResult{}, grepError(stderr.String(), runErr)
		}
		files, truncated := parseRipgrepJSON(stdout.Bytes(), root)
		return GrepResult{Engine: "ripgrep", RgAvailable: true, Truncated: truncated, Files: files}, nil
	}

	if currentGOOS == "windows" {
		return GrepResult{RgAvailable: false}, nil
	}
	grepPath, err := resolveGrepBinary()
	if err != nil {
		return GrepResult{RgAvailable: false}, nil
	}

	cmd := exec.CommandContext(ctx, grepPath, grepFallbackArgs(query, opts, root)...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	if runErr != nil && !isLocalNoMatchExit(runErr) {
		return GrepResult{}, grepError(stderr.String(), runErr)
	}

	files, truncated := parseGrepOutput(stdout.Bytes(), root)
	return GrepResult{Engine: "grep", RgAvailable: false, Truncated: truncated, Files: files}, nil
}

// InstallRipgrep downloads and installs ripgrep locally (on whichever
// process owns worktreeID — the hub for local/unassigned projects, or the
// remote runtime process itself for Machine-assigned ones, since this
// handler already runs on that process) via rginstall.InstallLocal, so the
// very next Grep call picks it up. worktreeID is validated against the
// store first (consistent 404 for an unknown id, matching every other
// worktree-scoped route) even though the install itself is host-global and
// doesn't otherwise depend on the worktree.
func (svc *WorktreeFileService) InstallRipgrep(ctx context.Context, worktreeID string) (string, error) {
	if _, err := svc.worktreeRoot(worktreeID); err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, rgInstallTimeout)
	defer cancel()

	_, version, err := installRipgrepLocal(ctx, currentGOOS, currentGOARCH)
	if err != nil {
		return "", err
	}
	return version, nil
}

// rgGrepArgs builds `rg --json` argv shared by both the local (os/exec) and
// SSH (sshmgr.RunCommand) Grep implementations: literal-vs-regex, case
// sensitivity, an optional include glob, `--glob '!DIR'` excludes for the
// same directories filename search already skips (searchSkipDirs), and the
// absolute search root as rg's final positional path argument — so
// parseRipgrepJSON can strip one common prefix regardless of which
// implementation ran it.
func rgGrepArgs(query string, opts GrepOptions, root string) []string {
	args := []string{"--json", "--no-heading"}
	if !opts.Regex {
		args = append(args, "--fixed-strings")
	}
	if opts.CaseSensitive {
		args = append(args, "--case-sensitive")
	} else {
		args = append(args, "--ignore-case")
	}
	if opts.IncludePattern != "" {
		args = append(args, "--glob", opts.IncludePattern)
	}
	skipDirs := make([]string, 0, len(searchSkipDirs))
	for dir := range searchSkipDirs {
		skipDirs = append(skipDirs, dir)
	}
	sort.Strings(skipDirs)
	for _, dir := range skipDirs {
		args = append(args, "--glob", "!"+dir)
	}
	args = append(args, "--", query, root)
	return args
}

// grepFallbackArgs builds `grep -rn` argv shared by both the local
// (os/exec) and SSH (sshmgr.RunCommand) Grep fallback implementations,
// invoked when ripgrep isn't installed: recursive (-r), line numbers (-n),
// skip binary files (-I — rg does this automatically, grep needs it spelled
// out), `--exclude-dir=DIR` for the same directories rgGrepArgs excludes via
// --glob, an optional `--include=GLOB` matching rgGrepArgs's --glob
// opts.IncludePattern, case-insensitive (-i) unless opts.CaseSensitive, and
// literal-string matching (-F) unless opts.Regex — grep's default is POSIX
// basic regex, not literal, unlike ripgrep's default. "--" ends option
// parsing so a query starting with "-" is never misread as a flag, and root
// is the final positional argument, matching rgGrepArgs so parseGrepOutput
// can strip the same absolute-root prefix regardless of which engine
// produced the output.
func grepFallbackArgs(query string, opts GrepOptions, root string) []string {
	args := []string{"-r", "-n", "-I"}
	skipDirs := make([]string, 0, len(searchSkipDirs))
	for dir := range searchSkipDirs {
		skipDirs = append(skipDirs, dir)
	}
	sort.Strings(skipDirs)
	for _, dir := range skipDirs {
		args = append(args, "--exclude-dir="+dir)
	}
	if opts.IncludePattern != "" {
		args = append(args, "--include="+opts.IncludePattern)
	}
	if !opts.CaseSensitive {
		args = append(args, "-i")
	}
	if !opts.Regex {
		args = append(args, "-F")
	}
	args = append(args, "--", query, root)
	return args
}

// isLocalNoMatchExit reports whether err is a local *exec.ExitError with
// the "no matches found" exit code (1) POSIX grep and ripgrep both use for
// success-with-zero-results — not a failure. Any other exit code (2:
// usage/regex error, ...) is a real failure. Shared by both engines since
// both follow the same exit-code convention.
func isLocalNoMatchExit(err error) bool {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode() == 1
	}
	return false
}

// grepError turns a failed rg invocation's stderr into an actionable
// validation error (almost always an invalid regex, the only user-supplied
// input rg would reject outright given a valid, existing root) — mirrors
// the "never leak raw subprocess error detail beyond a short, safe message"
// convention firstLine/ToolUnavailableError establish in tools.go.
func grepError(stderr string, runErr error) error {
	msg := firstLine(stderr)
	if msg == "" {
		return fmt.Errorf("search failed: %v", runErr)
	}
	return fmt.Errorf("search failed: %s: %w", msg, ErrValidation)
}

// rgJSONEvent is one line of ripgrep's --json output stream. Only the
// "match" event type carries fields parseRipgrepJSON needs; begin/end/
// summary events are ignored.
type rgJSONEvent struct {
	Type string `json:"type"`
	Data struct {
		Path struct {
			Text string `json:"text"`
		} `json:"path"`
		Lines struct {
			Text string `json:"text"`
		} `json:"lines"`
		LineNumber int `json:"line_number"`
		Submatches []struct {
			Start int `json:"start"`
		} `json:"submatches"`
	} `json:"data"`
}

// parseRipgrepJSON parses `rg --json` output (one JSON object per line) into
// GrepFileMatch groups, stripping rootPrefix — the absolute search root
// passed as rg's final positional argument by rgGrepArgs — from each
// match's path so results come back relative, regardless of whether the
// absolute root was a local worktree checkout or a remote SSH home
// directory. Uses filepath.Rel + filepath.ToSlash (same pattern as Search,
// above) rather than a hardcoded "/"-separated prefix, since rg prints paths
// using the host OS's native separator (backslash on Windows), which a
// forward-slash TrimPrefix would silently fail to strip. Caps at
// maxGrepFiles distinct files and maxGrepMatchesPerFile matches per file,
// reporting truncated=true if either cap was hit.
func parseRipgrepJSON(output []byte, rootPrefix string) (files []GrepFileMatch, truncated bool) {
	byPath := make(map[string]*GrepFileMatch)
	order := make([]string, 0)

	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var event rgJSONEvent
		if err := json.Unmarshal(line, &event); err != nil || event.Type != "match" {
			continue
		}
		relPath := event.Data.Path.Text
		if rel, err := filepath.Rel(rootPrefix, relPath); err == nil {
			relPath = filepath.ToSlash(rel)
		}
		entry, ok := byPath[relPath]
		if !ok {
			if len(order) >= maxGrepFiles {
				truncated = true
				continue
			}
			entry = &GrepFileMatch{Path: relPath}
			byPath[relPath] = entry
			order = append(order, relPath)
		}
		if len(entry.Matches) >= maxGrepMatchesPerFile {
			truncated = true
			continue
		}
		column := 1
		if len(event.Data.Submatches) > 0 {
			column = event.Data.Submatches[0].Start + 1
		}
		entry.Matches = append(entry.Matches, GrepMatch{
			Line:   event.Data.LineNumber,
			Column: column,
			Text:   strings.TrimRight(event.Data.Lines.Text, "\n"),
		})
	}

	files = make([]GrepFileMatch, 0, len(order))
	for _, p := range order {
		files = append(files, *byPath[p])
	}
	return files, truncated
}

// parseGrepOutput parses `grep -rn` plain-text output — one "path:line:text"
// line per match, NOT JSON like rg --json — into GrepFileMatch groups,
// stripping rootPrefix the same way parseRipgrepJSON does. Column is always
// 0: unlike ripgrep's --json submatch offsets, grep doesn't report a match
// column by default, so 0 is used as an explicit "unknown" sentinel rather
// than guessing one. Each line is split into at most 3 fields (path, line
// number, text) via strings.SplitN, since the matched text can itself
// legitimately contain colons (URLs, "key: value" pairs, timestamps, ...) —
// a naive strings.Split(line, ":") would misparse those; capping at 3 fields
// lets everything after the first two colons flow into Text untouched.
// Malformed lines (not exactly 3 fields, or a non-numeric line number) are
// skipped rather than failing the whole parse.
func parseGrepOutput(output []byte, rootPrefix string) (files []GrepFileMatch, truncated bool) {
	prefix := strings.TrimSuffix(rootPrefix, "/") + "/"
	byPath := make(map[string]*GrepFileMatch)
	order := make([]string, 0)

	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		lineNumber, err := strconv.Atoi(parts[1])
		if err != nil {
			continue
		}
		relPath := strings.TrimPrefix(parts[0], prefix)
		entry, ok := byPath[relPath]
		if !ok {
			if len(order) >= maxGrepFiles {
				truncated = true
				continue
			}
			entry = &GrepFileMatch{Path: relPath}
			byPath[relPath] = entry
			order = append(order, relPath)
		}
		if len(entry.Matches) >= maxGrepMatchesPerFile {
			truncated = true
			continue
		}
		entry.Matches = append(entry.Matches, GrepMatch{
			Line:   lineNumber,
			Column: 0,
			Text:   parts[2],
		})
	}

	files = make([]GrepFileMatch, 0, len(order))
	for _, p := range order {
		files = append(files, *byPath[p])
	}
	return files, truncated
}

type fileSearchMatch struct {
	path  string
	score int
}

type filePathMatcher struct {
	raw       string
	lower     string
	tokens    []string
	compact   string
	regex     *regexp.Regexp
	regexOnly bool
}

func newFilePathMatcher(pattern string) filePathMatcher {
	rawInput := strings.TrimSpace(pattern)
	if looksLikeRegex(rawInput) {
		if re, err := regexp.Compile(rawInput); err == nil {
			return filePathMatcher{raw: rawInput, lower: strings.ToLower(rawInput), regex: re, regexOnly: true}
		}
	}
	raw := strings.ReplaceAll(rawInput, "\\", "/")
	matcher := filePathMatcher{raw: raw, lower: strings.ToLower(raw)}
	matcher.tokens = searchTokens(raw)
	matcher.compact = compactSearchText(matcher.lower)
	return matcher
}

func looksLikeRegex(query string) bool {
	return strings.ContainsAny(query, `^$*+?()[]{}|`) || strings.Contains(query, `\.`)
}

func addFileSearchMatch(matches *[]fileSearchMatch, matcher filePathMatcher, candidate string, isDir bool) {
	if score, ok := matcher.score(candidate, isDir); ok {
		*matches = append(*matches, fileSearchMatch{path: candidate, score: score})
	}
}

func (matcher filePathMatcher) score(candidate string, isDir bool) (int, bool) {
	if matcher.raw == "" {
		score := 500 + strings.Count(candidate, "/")*8 + len(candidate)
		if isDir {
			score -= 4
		}
		return score, true
	}
	if matcher.regexOnly {
		if matcher.regex.MatchString(candidate) || matcher.regex.MatchString(strings.TrimSuffix(candidate, "/")) {
			return 0, true
		}
		return 0, false
	}

	lowerCandidate := strings.ToLower(candidate)
	cleanCandidate := strings.TrimSuffix(lowerCandidate, "/")
	cleanQuery := strings.TrimSuffix(matcher.lower, "/")
	base := path.Base(cleanCandidate)
	bias := 0
	if isDir {
		bias = -2
	}

	if cleanCandidate == cleanQuery || lowerCandidate == matcher.lower {
		return bias, true
	}
	if base == cleanQuery {
		return bias + 5, true
	}
	if strings.HasPrefix(lowerCandidate, matcher.lower) || strings.HasPrefix(cleanCandidate, cleanQuery) {
		return bias + 10 + len(cleanCandidate) - len(cleanQuery), true
	}
	if strings.HasPrefix(base, cleanQuery) {
		return bias + 25 + len(base) - len(cleanQuery), true
	}
	if index := strings.Index(lowerCandidate, matcher.lower); index >= 0 {
		return bias + 40 + index, true
	}
	if score, ok := tokenSequenceScore(lowerCandidate, matcher.tokens); ok {
		return bias + 80 + score, true
	}
	if score, ok := subsequenceScore(compactSearchText(cleanCandidate), matcher.compact); ok {
		return bias + 120 + score, true
	}
	return 0, false
}

func searchTokens(query string) []string {
	return strings.FieldsFunc(strings.ToLower(query), func(r rune) bool {
		switch r {
		case '/', '\\', ' ', '-', '_', '.':
			return true
		default:
			return false
		}
	})
}

func tokenSequenceScore(candidate string, tokens []string) (int, bool) {
	if len(tokens) == 0 {
		return 0, false
	}
	cursor := 0
	score := 0
	for _, token := range tokens {
		index := strings.Index(candidate[cursor:], token)
		if index < 0 {
			return 0, false
		}
		score += cursor + index
		cursor += index + len(token)
	}
	return score, true
}

func compactSearchText(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	for _, r := range value {
		switch r {
		case '/', '\\', ' ', '-', '_', '.':
			continue
		default:
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func subsequenceScore(candidate, query string) (int, bool) {
	if query == "" {
		return 0, true
	}
	queryIndex := 0
	previous := -1
	score := 0
	for index := 0; index < len(candidate); index++ {
		if candidate[index] != query[queryIndex] {
			continue
		}
		if previous >= 0 {
			score += index - previous - 1
		}
		previous = index
		queryIndex++
		if queryIndex == len(query) {
			return score, true
		}
	}
	return 0, false
}

type resolvedWorktreePath struct {
	clean  string
	target string
	info   fs.FileInfo
}

func (svc *WorktreeFileService) resolveSelection(worktreeID string, paths []string) ([]resolvedWorktreePath, error) {
	pruned, err := cleanAndPruneSelection(paths, func(clean string) error { return rejectReservedPath(clean, false) })
	if err != nil {
		return nil, err
	}

	selection := make([]resolvedWorktreePath, 0, len(pruned))
	for _, clean := range pruned {
		_, target, _, err := svc.resolve(worktreeID, clean, false, false)
		if err != nil {
			return nil, err
		}
		info, err := os.Lstat(target)
		if err != nil {
			return nil, fileOperationError("inspect file", clean, err)
		}
		selection = append(selection, resolvedWorktreePath{clean: clean, target: target, info: info})
	}
	return selection, nil
}

func safeUploadName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || name == "." || name == ".." {
		return "", fmt.Errorf("file name is required: %w", ErrValidation)
	}
	if strings.ContainsAny(name, "/\\") || strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("file name must not contain folder separators: %w", ErrValidation)
	}
	if isReservedSegment(name) {
		return "", fmt.Errorf("%q is reserved: %w", name, ErrValidation)
	}
	return name, nil
}

func rejectReservedPath(clean string, allowRoot bool) error {
	if clean == "" {
		if allowRoot {
			return nil
		}
		return fmt.Errorf("file path is required: %w", ErrValidation)
	}
	for _, segment := range strings.Split(clean, "/") {
		if isReservedSegment(segment) {
			return fmt.Errorf("%q is reserved: %w", segment, ErrValidation)
		}
	}
	return nil
}

func isReservedSegment(segment string) bool {
	return segment == ".git" || segment == ".wt"
}

func addPathToZip(zw *zip.Writer, item resolvedWorktreePath, seen map[string]bool) error {
	if item.info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%q is a symlink: %w", item.clean, ErrValidation)
	}
	if !item.info.IsDir() {
		return addFileToZip(zw, item.target, item.clean, item.info, seen)
	}
	parent := filepath.Dir(item.target)
	return filepath.WalkDir(item.target, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, fs.ErrPermission) {
				return nil
			}
			return walkErr
		}
		if current != item.target && entry.IsDir() && isReservedSegment(entry.Name()) {
			return filepath.SkipDir
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		relative, err := filepath.Rel(parent, current)
		if err != nil {
			return err
		}
		zipName := filepath.ToSlash(relative)
		info, err := entry.Info()
		if err != nil {
			return fileOperationError("inspect file", zipName, err)
		}
		if entry.IsDir() {
			return addDirToZip(zw, zipName, info, seen)
		}
		return addFileToZip(zw, current, zipName, info, seen)
	})
}

func addDirToZip(zw *zip.Writer, zipName string, info fs.FileInfo, seen map[string]bool) error {
	if !strings.HasSuffix(zipName, "/") {
		zipName += "/"
	}
	if seen[zipName] {
		return nil
	}
	seen[zipName] = true
	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return fmt.Errorf("zip folder %q failed", zipName)
	}
	header.Name = zipName
	_, err = zw.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("zip folder %q failed", zipName)
	}
	return nil
}

func addFileToZip(zw *zip.Writer, filePath, zipName string, info fs.FileInfo, seen map[string]bool) error {
	if seen[zipName] {
		return nil
	}
	seen[zipName] = true
	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return fmt.Errorf("zip file %q failed", zipName)
	}
	header.Name = zipName
	header.Method = zip.Deflate
	writer, err := zw.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("zip file %q failed", zipName)
	}
	file, err := os.Open(filePath)
	if err != nil {
		return fileOperationError("read file", zipName, err)
	}
	defer file.Close()
	if _, err := io.Copy(writer, file); err != nil {
		return fmt.Errorf("zip file %q failed", zipName)
	}
	return nil
}

func (svc *WorktreeFileService) resolve(
	worktreeID string,
	relativePath string,
	allowRoot bool,
	allowMissing bool,
) (root string, target string, clean string, err error) {
	clean, err = normalizeRelativePath(relativePath, allowRoot)
	if err != nil {
		return "", "", "", err
	}

	root, err = svc.worktreeRoot(worktreeID)
	if err != nil {
		return "", "", "", err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", "", "", fmt.Errorf("resolve worktree path failed")
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", "", "", fileOperationError("resolve worktree", "", err)
	}

	target = filepath.Join(root, filepath.FromSlash(clean))
	if err := ensureInside(root, target); err != nil {
		return "", "", "", err
	}

	if allowMissing {
		if _, err := os.Lstat(target); err == nil {
			resolved, err := filepath.EvalSymlinks(target)
			if err != nil {
				return "", "", "", fileOperationError("resolve file", clean, err)
			}
			if err := ensureInside(root, resolved); err != nil {
				return "", "", "", err
			}
		} else if os.IsNotExist(err) {
			parent, err := filepath.EvalSymlinks(filepath.Dir(target))
			if err != nil {
				return "", "", "", fileOperationError("resolve parent folder", clean, err)
			}
			if err := ensureInside(root, parent); err != nil {
				return "", "", "", err
			}
		} else {
			return "", "", "", fileOperationError("inspect file", clean, err)
		}
		return root, target, clean, nil
	}

	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", "", "", fileOperationError("resolve path", clean, err)
	}
	if err := ensureInside(root, resolved); err != nil {
		return "", "", "", err
	}
	return root, target, clean, nil
}

func (svc *WorktreeFileService) worktreeRoot(worktreeID string) (string, error) {
	worktree, err := svc.store.WorktreeByID(worktreeID)
	if err != nil {
		return "", err
	}
	projectRoot := gitpkg.ExpandHome(worktree.Path)
	if worktree.Root {
		return projectRoot, nil
	}
	return filepath.Join(projectRoot, ".wt", worktreeID), nil
}

func normalizeRelativePath(raw string, allowRoot bool) (string, error) {
	normalized := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	if normalized == "" || normalized == "." {
		if allowRoot {
			return "", nil
		}
		return "", fmt.Errorf("file path is required: %w", ErrValidation)
	}
	nativePath := filepath.FromSlash(normalized)
	hasWindowsVolume := len(normalized) >= 2 &&
		normalized[1] == ':' &&
		((normalized[0] >= 'a' && normalized[0] <= 'z') ||
			(normalized[0] >= 'A' && normalized[0] <= 'Z'))
	if strings.HasPrefix(normalized, "/") ||
		hasWindowsVolume ||
		filepath.IsAbs(nativePath) ||
		filepath.VolumeName(nativePath) != "" {
		return "", fmt.Errorf("absolute paths are not allowed: %w", ErrValidation)
	}
	for _, segment := range strings.Split(normalized, "/") {
		if segment == ".." {
			return "", fmt.Errorf("path traversal is not allowed: %w", ErrValidation)
		}
	}
	clean := path.Clean(normalized)
	if clean == "." || clean == "" {
		if allowRoot {
			return "", nil
		}
		return "", fmt.Errorf("file path is required: %w", ErrValidation)
	}
	return clean, nil
}

func ensureInside(root, target string) error {
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes the worktree: %w", ErrValidation)
	}
	return nil
}

func fileOperationError(operation, relativePath string, err error) error {
	if os.IsNotExist(err) {
		return fmt.Errorf("%s %q: %w", operation, relativePath, store.ErrNotFound)
	}
	if errors.Is(err, fs.ErrPermission) {
		return fmt.Errorf("permission denied for %q: %w", relativePath, ErrValidation)
	}
	return fmt.Errorf("%s %q failed", operation, relativePath)
}
