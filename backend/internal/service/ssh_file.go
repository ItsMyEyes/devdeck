package service

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"devdeck/backend/internal/rginstall"
	"devdeck/backend/internal/sshmgr"
)

// sshSearchBudget bounds how long Search's remote `find` may run before its
// context is canceled — a safety net for a huge or slow remote home
// directory, not the common case: unlike the old SFTP-walk implementation
// (one round trip per directory), `find` runs entirely on the remote host and
// returns its full listing in one round trip, so this budget is rarely hit.
const sshSearchBudget = 6 * time.Second

// sshRgInstallTimeout bounds how long InstallRipgrep's GitHub API call +
// asset download + extract + remote SFTP write may run before being
// canceled — same spirit as worktree_file.go's rgInstallTimeout.
const sshRgInstallTimeout = 60 * time.Second

// installRipgrepOverSSH wraps rginstall.InstallOverSSH, overridable in
// tests via direct reassignment — same pattern as
// worktree_file.go's installRipgrepLocal — so InstallRipgrep's tests don't
// require real network access.
var installRipgrepOverSSH = rginstall.InstallOverSSH

// SSHFileEntry is one visible item in an SSH connection's remote directory.
// Same shape as WorktreeFileEntry — kept as its own type since the two
// sources (a local worktree checkout vs. a remote host over SFTP) are
// otherwise unrelated, even though the frontend renders both with the same
// Explorer component.
type SSHFileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

// SSHFileContent is the editable text representation of a remote file.
type SSHFileContent struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// SSHFileService provides file access to a saved SSH connection's remote
// filesystem over SFTP, rooted at the connection's home directory (SFTP's
// initial working directory) — mirrors WorktreeFileService's "no absolute
// paths, no .. traversal" contract via the same normalizeRelativePath, but
// there is no symlink-escape hardening here: unlike a worktree checkout
// (where escaping the root is a real security boundary), the remote sshd
// already governs what this user's session can reach, so there is nothing
// extra for DevDeck to enforce.
type SSHFileService struct {
	pool *sshmgr.FilePool
}

func NewSSHFileService(pool *sshmgr.FilePool) *SSHFileService {
	return &SSHFileService{pool: pool}
}

// remoteAbsPath resolves clean (already normalizeRelativePath'd) against the
// connection's home directory. Re-fetches the home dir on every call rather
// than caching it — an extra SFTP REALPATH round trip is imperceptible next
// to a human clicking through a file tree, and it keeps the pool free of
// per-connection cached state that would need invalidating on redial.
func remoteAbsPath(client *sftp.Client, clean string) (string, error) {
	home, err := client.Getwd()
	if err != nil {
		return "", fmt.Errorf("resolve home directory failed")
	}
	if clean == "" {
		return home, nil
	}
	return path.Join(home, clean), nil
}

func (svc *SSHFileService) List(ctx context.Context, connectionID, relativePath string) ([]SSHFileEntry, error) {
	clean, err := normalizeRelativePath(relativePath, true)
	if err != nil {
		return nil, err
	}
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) ([]SSHFileEntry, error) {
		abs, err := remoteAbsPath(client, clean)
		if err != nil {
			return nil, err
		}
		infos, err := client.ReadDir(abs)
		if err != nil {
			return nil, fileOperationError("read folder", clean, err)
		}
		result := make([]SSHFileEntry, 0, len(infos))
		for _, info := range infos {
			size := int64(0)
			if !info.IsDir() {
				size = info.Size()
			}
			result = append(result, SSHFileEntry{
				Name:  info.Name(),
				Path:  path.Join(clean, info.Name()),
				IsDir: info.IsDir(),
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
	})
}

// findListArgs builds a `find <root> ...` argv that lists every file (or,
// when wantDirs is true, every directory) under root, one per line, skipping
// the same directories by name (wherever they occur, not just at the top
// level) that WorktreeFileService.Search's local walk and rgGrepArgs/
// grepFallbackArgs already exclude (searchSkipDirs). `-mindepth 1` excludes
// root itself, matching the old walker's "skip the starting entry" check.
// find's default (non `-L`) `-type f`/`-type d` tests never match a symlink
// (its own type is `l`), so symlinks are skipped for free, mirroring the old
// walker's explicit os.ModeSymlink check. Only skip-dir names and the
// (server-controlled) root path go into this command — the user-supplied
// search pattern never does; matching happens entirely in Go afterward via
// filePathMatcher, so there is no shell-injection surface here the way there
// is for Grep's query/includePattern.
func findListArgs(root string, wantDirs bool) []string {
	skipDirs := make([]string, 0, len(searchSkipDirs))
	for dir := range searchSkipDirs {
		skipDirs = append(skipDirs, dir)
	}
	sort.Strings(skipDirs)

	args := []string{"find", root, "-mindepth", "1"}
	if len(skipDirs) > 0 {
		args = append(args, "(")
		for i, dir := range skipDirs {
			if i > 0 {
				args = append(args, "-o")
			}
			args = append(args, "-name", dir)
		}
		args = append(args, ")", "-prune", "-o")
	}
	if wantDirs {
		args = append(args, "-type", "d", "-print")
	} else {
		args = append(args, "-type", "f", "-print")
	}
	return args
}

// listRemotePaths runs findListArgs(root, wantDirs) over connectionID's
// pooled SSH connection and scores each returned line against matcher,
// appending hits to matches. A nonzero find exit status (e.g. one
// permission-denied subdirectory among many readable ones) is not treated as
// fatal — whatever it printed to stdout before that is still used, mirroring
// the old walker's "skip permission-denied entries, keep going" behavior;
// only a transport-level failure (already retried once inside
// sshmgr.RunCommand) leaves stdout empty.
func listRemotePaths(
	ctx context.Context,
	pool *sshmgr.FilePool,
	connectionID, root, homePrefix string,
	matcher filePathMatcher,
	matches *[]fileSearchMatch,
	wantDirs bool,
) error {
	stdout, _, _ := sshmgr.RunCommand(ctx, pool, connectionID, findListArgs(root, wantDirs))
	scanner := bufio.NewScanner(bytes.NewReader(stdout))
	scanner.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		relative := strings.TrimPrefix(line, homePrefix)
		if wantDirs {
			addFileSearchMatch(matches, matcher, relative+"/", true)
		} else {
			addFileSearchMatch(matches, matcher, relative, false)
		}
	}
	return scanner.Err()
}

// Search returns remote file paths matched by the same fuzzy/regex matcher
// as WorktreeFileService.Search (shared filePathMatcher, searchSkipDirs,
// maxFileSearchResults — defined in worktree_file.go, same package). Unlike
// the old implementation (an sftp.Client.Walk costing one SFTP round trip per
// directory — slow enough that an interactive quick-open search needed its
// own time budget to avoid hanging), this execs `find` once (twice when
// includeDirs is set: once for files, once for directories) over the pooled
// SSH connection via sshmgr.RunCommand, same transport Grep already uses —
// trading many small round trips for one or two, with the whole listing
// streamed back in a single response.
func (svc *SSHFileService) Search(ctx context.Context, connectionID, pattern string, includeDirs bool) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, sshSearchBudget)
	defer cancel()

	home, err := sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (string, error) {
		return client.Getwd()
	})
	if err != nil {
		return nil, fmt.Errorf("resolve home directory failed")
	}
	homePrefix := strings.TrimSuffix(home, "/") + "/"

	matcher := newFilePathMatcher(pattern)
	matches := make([]fileSearchMatch, 0)
	if err := listRemotePaths(ctx, svc.pool, connectionID, home, homePrefix, matcher, &matches, false); err != nil {
		return nil, fmt.Errorf("search files failed")
	}
	if includeDirs {
		if err := listRemotePaths(ctx, svc.pool, connectionID, home, homePrefix, matcher, &matches, true); err != nil {
			return nil, fmt.Errorf("search files failed")
		}
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

// Grep searches remote file contents under connectionID's home directory
// using ripgrep, if installed on the remote host, falling back to `grep`
// when it isn't — mirrors WorktreeFileService.Grep's contract exactly (same
// shared GrepOptions/GrepResult types, same rgGrepArgs/grepFallbackArgs and
// parseRipgrepJSON/parseGrepOutput, same "neither engine found ->
// GrepResult{RgAvailable: false}, nil error" behavior) but detects and
// executes over the pooled SSH connection (sshmgr.CommandExists /
// sshmgr.RunCommand) instead of a local subprocess. Unlike the worktree
// path, there is no Windows special-case here: SSH remote hosts are assumed
// POSIX (see the design spec's SSH scope note — every other SSH feature in
// this codebase makes the same assumption), so the grep fallback is always
// attempted when rg isn't found.
//
// Command construction safety: query/opts.IncludePattern are untrusted
// HTTP-query-param input forwarded into a remote shell command. They are
// never interpolated into a command string here — rgGrepArgs/
// grepFallbackArgs return a []string argv, and sshmgr.RunCommand is the sole
// place that turns it into one shell command, doing so through
// shellJoin/shellQuote's strict POSIX single-quote escaping (see
// sshmgr/exec.go) so every argument is delivered to the remote shell as one
// literal word, never reinterpreted as shell syntax no matter what
// characters it contains.
func (svc *SSHFileService) Grep(ctx context.Context, connectionID, query string, opts GrepOptions) (GrepResult, error) {
	if strings.TrimSpace(query) == "" {
		return GrepResult{}, fmt.Errorf("query is required: %w", ErrValidation)
	}

	rgFound, err := sshmgr.CommandExists(ctx, svc.pool, connectionID, "rg")
	if err != nil {
		return GrepResult{}, err
	}

	engine := "rg"
	if !rgFound {
		grepFound, err := sshmgr.CommandExists(ctx, svc.pool, connectionID, "grep")
		if err != nil {
			return GrepResult{}, err
		}
		if !grepFound {
			return GrepResult{RgAvailable: false}, nil
		}
		engine = "grep"
	}

	home, err := sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (string, error) {
		return client.Getwd()
	})
	if err != nil {
		return GrepResult{}, fmt.Errorf("resolve home directory failed")
	}

	if engine == "rg" {
		args := append([]string{"rg"}, rgGrepArgs(query, opts, home)...)
		stdout, stderr, runErr := sshmgr.RunCommand(ctx, svc.pool, connectionID, args)
		if runErr != nil && !isRemoteNoMatchExit(runErr) {
			return GrepResult{}, grepError(string(stderr), runErr)
		}
		files, truncated := parseRipgrepJSON(stdout, home)
		return GrepResult{Engine: "ripgrep", RgAvailable: true, Truncated: truncated, Files: files}, nil
	}

	args := append([]string{"grep"}, grepFallbackArgs(query, opts, home)...)
	stdout, stderr, runErr := sshmgr.RunCommand(ctx, svc.pool, connectionID, args)
	if runErr != nil && !isRemoteNoMatchExit(runErr) {
		return GrepResult{}, grepError(string(stderr), runErr)
	}
	files, truncated := parseGrepOutput(stdout, home)
	return GrepResult{Engine: "grep", RgAvailable: false, Truncated: truncated, Files: files}, nil
}

// InstallRipgrep downloads ripgrep on the hub (rginstall.InstallOverSSH
// probes the remote OS/arch first) and writes it to connectionID's remote
// ~/.local/bin/rg over the already-open pooled SFTP connection, so a
// firewalled remote host never needs outbound internet access itself and
// the very next Grep call picks it up.
func (svc *SSHFileService) InstallRipgrep(ctx context.Context, connectionID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, sshRgInstallTimeout)
	defer cancel()
	return installRipgrepOverSSH(ctx, svc.pool, connectionID)
}

// isRemoteNoMatchExit reports whether err is a remote *ssh.ExitError with
// the "no matches found" exit code (1) POSIX grep and ripgrep both use for
// success-with-zero-results — not a failure. Mirrors isLocalNoMatchExit for
// the SSH exec transport, where a nonzero remote exit surfaces as
// *ssh.ExitError instead of *exec.ExitError.
func isRemoteNoMatchExit(err error) bool {
	var exitErr *ssh.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitStatus() == 1
	}
	return false
}

func (svc *SSHFileService) Read(ctx context.Context, connectionID, relativePath string) (SSHFileContent, error) {
	clean, err := normalizeRelativePath(relativePath, false)
	if err != nil {
		return SSHFileContent{}, err
	}
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (SSHFileContent, error) {
		abs, err := remoteAbsPath(client, clean)
		if err != nil {
			return SSHFileContent{}, err
		}
		info, err := client.Stat(abs)
		if err != nil {
			return SSHFileContent{}, fileOperationError("read file", clean, err)
		}
		if info.IsDir() {
			return SSHFileContent{}, fmt.Errorf("%q is a folder: %w", clean, ErrValidation)
		}
		if info.Size() > maxEditableFileSize {
			return SSHFileContent{}, fmt.Errorf(
				"%q is larger than the %d MB editor limit: %w",
				clean,
				maxEditableFileSize/(1<<20),
				ErrValidation,
			)
		}
		file, err := client.Open(abs)
		if err != nil {
			return SSHFileContent{}, fileOperationError("read file", clean, err)
		}
		defer file.Close()
		data, err := io.ReadAll(file)
		if err != nil {
			return SSHFileContent{}, fileOperationError("read file", clean, err)
		}
		if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
			return SSHFileContent{}, fmt.Errorf("%q is not a UTF-8 text file: %w", clean, ErrValidation)
		}
		return SSHFileContent{Path: clean, Content: string(data)}, nil
	})
}

// SSHDownloadMeta describes a downloaded remote file, carrying what the
// handler needs for its response headers once the bytes are already streamed.
type SSHDownloadMeta struct {
	Path    string
	Size    int64
	ModTime time.Time
}

// Download streams a remote file's raw bytes into dst. Validation mirrors
// Read (normalizeRelativePath -> remoteAbsPath -> Stat, rejecting
// directories) but deliberately applies neither maxEditableFileSize nor the
// UTF-8/NUL check: those protect the editor, and a download has neither
// constraint — this is what makes binary and oversized remote files
// retrievable at all.
//
// It takes a destination writer rather than returning a handle because
// sshmgr.WithSFTPClient scopes the *sftp.Client to its callback, so a live
// remote handle cannot outlive it — same shape as Archive above.
func (svc *SSHFileService) Download(ctx context.Context, connectionID, relativePath string, dst io.Writer) (SSHDownloadMeta, error) {
	clean, err := normalizeRelativePath(relativePath, false)
	if err != nil {
		return SSHDownloadMeta{}, err
	}
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (SSHDownloadMeta, error) {
		abs, err := remoteAbsPath(client, clean)
		if err != nil {
			return SSHDownloadMeta{}, err
		}
		info, err := client.Stat(abs)
		if err != nil {
			return SSHDownloadMeta{}, fileOperationError("read file", clean, err)
		}
		if info.IsDir() {
			return SSHDownloadMeta{}, fmt.Errorf("%q is a folder — use zip to download folders: %w", clean, ErrValidation)
		}
		file, err := client.Open(abs)
		if err != nil {
			return SSHDownloadMeta{}, fileOperationError("read file", clean, err)
		}
		defer file.Close()
		written, err := io.Copy(dst, file)
		if err != nil {
			return SSHDownloadMeta{}, fileOperationError("read file", clean, err)
		}
		// Report what was actually transferred, not the pre-copy Stat size:
		// the remote file may have been appended to or truncated in between.
		return SSHDownloadMeta{Path: clean, Size: written, ModTime: info.ModTime()}, nil
	})
}

func (svc *SSHFileService) Write(ctx context.Context, connectionID, relativePath, content string) (SSHFileContent, error) {
	if len(content) > maxEditableFileSize {
		return SSHFileContent{}, fmt.Errorf(
			"content is larger than the %d MB editor limit: %w",
			maxEditableFileSize/(1<<20),
			ErrValidation,
		)
	}
	clean, err := normalizeRelativePath(relativePath, false)
	if err != nil {
		return SSHFileContent{}, err
	}
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (SSHFileContent, error) {
		abs, err := remoteAbsPath(client, clean)
		if err != nil {
			return SSHFileContent{}, err
		}
		if info, statErr := client.Stat(abs); statErr == nil {
			if info.IsDir() {
				return SSHFileContent{}, fmt.Errorf("%q is a folder: %w", clean, ErrValidation)
			}
		} else if !os.IsNotExist(statErr) {
			return SSHFileContent{}, fileOperationError("inspect file", clean, statErr)
		}

		out, err := client.Create(abs)
		if err != nil {
			return SSHFileContent{}, fileOperationError("write file", clean, err)
		}
		_, writeErr := out.Write([]byte(content))
		closeErr := out.Close()
		if writeErr != nil {
			return SSHFileContent{}, fileOperationError("write file", clean, writeErr)
		}
		if closeErr != nil {
			return SSHFileContent{}, fileOperationError("write file", clean, closeErr)
		}
		return SSHFileContent{Path: clean, Content: content}, nil
	})
}

// Mkdir creates an empty remote folder — SSH counterpart to
// WorktreeFileService.Mkdir, using sftp's MkdirAll instead of os.MkdirAll.
func (svc *SSHFileService) Mkdir(ctx context.Context, connectionID, relativePath string) (SSHFileEntry, error) {
	clean, err := normalizeRelativePath(relativePath, false)
	if err != nil {
		return SSHFileEntry{}, err
	}
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (SSHFileEntry, error) {
		abs, err := remoteAbsPath(client, clean)
		if err != nil {
			return SSHFileEntry{}, err
		}
		if _, statErr := client.Lstat(abs); statErr == nil {
			return SSHFileEntry{}, fmt.Errorf("%q already exists: %w", clean, ErrConflict)
		} else if !os.IsNotExist(statErr) {
			return SSHFileEntry{}, fileOperationError("inspect folder", clean, statErr)
		}
		if err := client.MkdirAll(abs); err != nil {
			return SSHFileEntry{}, fileOperationError("create folder", clean, err)
		}
		return SSHFileEntry{Name: path.Base(clean), Path: clean, IsDir: true}, nil
	})
}

// Move renames/relocates a remote file or folder — SSH counterpart to
// WorktreeFileService.Move (same conflict/self-nesting rules), using sftp's
// Rename (which itself fails if the destination already exists on a
// spec-conformant server, a second line of defense behind the explicit
// Lstat check below).
func (svc *SSHFileService) Move(ctx context.Context, connectionID, fromPath, toPath string) (SSHFileEntry, error) {
	fromClean, err := normalizeRelativePath(fromPath, false)
	if err != nil {
		return SSHFileEntry{}, err
	}
	toClean, err := normalizeRelativePath(toPath, false)
	if err != nil {
		return SSHFileEntry{}, err
	}
	if toClean == fromClean {
		return SSHFileEntry{}, fmt.Errorf("source and destination are the same: %w", ErrValidation)
	}
	if strings.HasPrefix(toClean, fromClean+"/") {
		return SSHFileEntry{}, fmt.Errorf("cannot move %q into itself: %w", fromClean, ErrValidation)
	}
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (SSHFileEntry, error) {
		fromAbs, err := remoteAbsPath(client, fromClean)
		if err != nil {
			return SSHFileEntry{}, err
		}
		toAbs, err := remoteAbsPath(client, toClean)
		if err != nil {
			return SSHFileEntry{}, err
		}
		info, err := client.Lstat(fromAbs)
		if err != nil {
			return SSHFileEntry{}, fileOperationError("inspect file", fromClean, err)
		}
		if _, statErr := client.Lstat(toAbs); statErr == nil {
			return SSHFileEntry{}, fmt.Errorf("%q already exists: %w", toClean, ErrConflict)
		} else if !os.IsNotExist(statErr) {
			return SSHFileEntry{}, fileOperationError("inspect file", toClean, statErr)
		}
		if err := client.Rename(fromAbs, toAbs); err != nil {
			return SSHFileEntry{}, fileOperationError("move file", fromClean, err)
		}
		return SSHFileEntry{Name: path.Base(toClean), Path: toClean, IsDir: info.IsDir()}, nil
	})
}

// Copy duplicates a remote file or folder (recursively, via client.Walk —
// same traversal Archive's addRemoteSelectionToZip uses) to a new remote
// path — SSH counterpart to WorktreeFileService.Copy.
func (svc *SSHFileService) Copy(ctx context.Context, connectionID, fromPath, toPath string) (SSHFileEntry, error) {
	fromClean, err := normalizeRelativePath(fromPath, false)
	if err != nil {
		return SSHFileEntry{}, err
	}
	toClean, err := normalizeRelativePath(toPath, false)
	if err != nil {
		return SSHFileEntry{}, err
	}
	if toClean == fromClean {
		return SSHFileEntry{}, fmt.Errorf("source and destination are the same: %w", ErrValidation)
	}
	if strings.HasPrefix(toClean, fromClean+"/") {
		return SSHFileEntry{}, fmt.Errorf("cannot copy %q into itself: %w", fromClean, ErrValidation)
	}
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (SSHFileEntry, error) {
		fromAbs, err := remoteAbsPath(client, fromClean)
		if err != nil {
			return SSHFileEntry{}, err
		}
		toAbs, err := remoteAbsPath(client, toClean)
		if err != nil {
			return SSHFileEntry{}, err
		}
		info, err := client.Lstat(fromAbs)
		if err != nil {
			return SSHFileEntry{}, fileOperationError("inspect file", fromClean, err)
		}
		if _, statErr := client.Lstat(toAbs); statErr == nil {
			return SSHFileEntry{}, fmt.Errorf("%q already exists: %w", toClean, ErrConflict)
		} else if !os.IsNotExist(statErr) {
			return SSHFileEntry{}, fileOperationError("inspect file", toClean, statErr)
		}
		if info.IsDir() {
			if err := copyRemoteDir(client, fromAbs, toAbs); err != nil {
				return SSHFileEntry{}, fileOperationError("copy folder", fromClean, err)
			}
		} else if err := copyRemoteFile(client, fromAbs, toAbs); err != nil {
			return SSHFileEntry{}, fileOperationError("copy file", fromClean, err)
		}
		return SSHFileEntry{Name: path.Base(toClean), Path: toClean, IsDir: info.IsDir()}, nil
	})
}

func copyRemoteFile(client *sftp.Client, from, to string) error {
	src, err := client.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := client.Create(to)
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

func copyRemoteDir(client *sftp.Client, from, to string) error {
	if err := client.MkdirAll(to); err != nil {
		return err
	}
	walker := client.Walk(from)
	for walker.Step() {
		if walker.Err() != nil {
			continue // permission-denied entries are skipped, mirroring addRemoteSelectionToZip
		}
		current := walker.Path()
		if current == from {
			continue
		}
		relative := strings.TrimPrefix(current, from+"/")
		dest := path.Join(to, relative)
		if walker.Stat().IsDir() {
			if err := client.MkdirAll(dest); err != nil {
				return err
			}
			continue
		}
		if err := copyRemoteFile(client, current, dest); err != nil {
			return err
		}
	}
	return nil
}

func (svc *SSHFileService) Delete(ctx context.Context, connectionID, relativePath string) error {
	clean, err := normalizeRelativePath(relativePath, false)
	if err != nil {
		return err
	}
	_, err = sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (struct{}, error) {
		abs, err := remoteAbsPath(client, clean)
		if err != nil {
			return struct{}{}, err
		}
		if err := client.Remove(abs); err != nil {
			return struct{}{}, fileOperationError("delete file", clean, err)
		}
		return struct{}{}, nil
	})
	return err
}

func (svc *SSHFileService) Upload(ctx context.Context, connectionID, folderPath string, uploads []WorktreeUploadFile) ([]SSHFileEntry, error) {
	if len(uploads) == 0 {
		return nil, fmt.Errorf("at least one file is required: %w", ErrValidation)
	}
	cleanDir, err := normalizeRelativePath(folderPath, true)
	if err != nil {
		return nil, err
	}
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) ([]SSHFileEntry, error) {
		absDir, err := remoteAbsPath(client, cleanDir)
		if err != nil {
			return nil, err
		}
		info, err := client.Stat(absDir)
		if err != nil {
			return nil, fileOperationError("inspect upload folder", cleanDir, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("%q is not a folder: %w", cleanDir, ErrValidation)
		}

		entries := make([]SSHFileEntry, 0, len(uploads))
		for _, upload := range uploads {
			name, err := safeUploadName(upload.Name)
			if err != nil {
				return nil, err
			}
			cleanPath := path.Join(cleanDir, name)
			abs := path.Join(absDir, name)
			if existing, statErr := client.Stat(abs); statErr == nil && existing.IsDir() {
				return nil, fmt.Errorf("%q is a folder: %w", cleanPath, ErrValidation)
			} else if statErr != nil && !os.IsNotExist(statErr) {
				return nil, fileOperationError("inspect upload target", cleanPath, statErr)
			}

			out, err := client.Create(abs)
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
			written, err := client.Stat(abs)
			if err != nil {
				return nil, fileOperationError("inspect upload", cleanPath, err)
			}
			entries = append(entries, SSHFileEntry{Name: name, Path: cleanPath, IsDir: false, Size: written.Size()})
		}
		return entries, nil
	})
}

func (svc *SSHFileService) DeleteMany(ctx context.Context, connectionID string, paths []string) error {
	pruned, err := cleanAndPruneSelection(paths, nil)
	if err != nil {
		return err
	}
	_, err = sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (struct{}, error) {
		for _, clean := range pruned {
			abs, err := remoteAbsPath(client, clean)
			if err != nil {
				return struct{}{}, err
			}
			if err := client.RemoveAll(abs); err != nil {
				return struct{}{}, fileOperationError("delete file", clean, err)
			}
		}
		return struct{}{}, nil
	})
	return err
}

func (svc *SSHFileService) Archive(ctx context.Context, connectionID string, paths []string, dst io.Writer) error {
	pruned, err := cleanAndPruneSelection(paths, nil)
	if err != nil {
		return err
	}
	_, err = sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (struct{}, error) {
		zw := zip.NewWriter(dst)
		seen := make(map[string]bool)
		for _, clean := range pruned {
			abs, err := remoteAbsPath(client, clean)
			if err != nil {
				_ = zw.Close()
				return struct{}{}, err
			}
			info, err := client.Lstat(abs)
			if err != nil {
				_ = zw.Close()
				return struct{}{}, fileOperationError("inspect file", clean, err)
			}
			if err := addRemoteSelectionToZip(client, zw, abs, clean, info, seen); err != nil {
				_ = zw.Close()
				return struct{}{}, err
			}
		}
		if err := zw.Close(); err != nil {
			return struct{}{}, fmt.Errorf("zip selection failed")
		}
		return struct{}{}, nil
	})
	return err
}

func addRemoteSelectionToZip(client *sftp.Client, zw *zip.Writer, abs, clean string, info os.FileInfo, seen map[string]bool) error {
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%q is a symlink: %w", clean, ErrValidation)
	}
	if !info.IsDir() {
		return addRemoteFileToZip(client, zw, abs, clean, info, seen)
	}

	parentPrefix := path.Dir(abs) + "/"
	walker := client.Walk(abs)
	for walker.Step() {
		if walker.Err() != nil {
			continue // permission-denied entries are skipped, mirroring the worktree archiver's fs.ErrPermission handling
		}
		current := walker.Path()
		entryInfo := walker.Stat()
		if entryInfo.Mode()&os.ModeSymlink != 0 {
			continue
		}
		zipName := strings.TrimPrefix(current, parentPrefix)
		if entryInfo.IsDir() {
			if err := addRemoteDirToZip(zw, zipName, entryInfo, seen); err != nil {
				return err
			}
			continue
		}
		if err := addRemoteFileToZip(client, zw, current, zipName, entryInfo, seen); err != nil {
			return err
		}
	}
	return nil
}

func addRemoteDirToZip(zw *zip.Writer, zipName string, info os.FileInfo, seen map[string]bool) error {
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
	if _, err := zw.CreateHeader(header); err != nil {
		return fmt.Errorf("zip folder %q failed", zipName)
	}
	return nil
}

func addRemoteFileToZip(client *sftp.Client, zw *zip.Writer, abs, zipName string, info os.FileInfo, seen map[string]bool) error {
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
	file, err := client.Open(abs)
	if err != nil {
		return fileOperationError("read file", zipName, err)
	}
	defer file.Close()
	if _, err := io.Copy(writer, file); err != nil {
		return fmt.Errorf("zip file %q failed", zipName)
	}
	return nil
}
