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
	"sync"
	"time"
	"unicode/utf8"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"devdeck/backend/internal/rginstall"
	"devdeck/backend/internal/sshmgr"
)

// sshSearchBudget bounds how long collecting a connection's remote path
// listing (Search's `find`) may run before its context is canceled — a
// safety net for a huge or slow remote home directory. Since RunCommand is
// context-aware this genuinely kills the remote command and frees its SSH
// channel, rather than merely abandoning a request that keeps running.
const sshSearchBudget = 20 * time.Second

// sshListingTTL is how long one connection's collected remote path listing
// is reused before it's re-collected.
//
// Without a cache, Search re-ran a full remote `find` over the entire home
// directory *per keystroke*: FileQuickOpen re-queries on every character
// (and once more, with an empty pattern, the moment it opens), and the
// pattern is only ever applied in Go afterward — so every one of those
// requests re-walked the identical tree to produce the identical listing.
// On a real host that is seconds of remote I/O each, and because nothing
// cancels an abandoned request, the finds pile up as concurrent SSH
// channels until sshd's per-connection MaxSessions cap (10 by default) is
// hit, at which point every later request — including the SFTP half of the
// same pooled connection — starts failing. Collecting once and matching
// in-process turns each keystroke into a pure in-memory scan.
const sshListingTTL = 30 * time.Second

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
	pool     *sshmgr.FilePool
	listings *sshListingCache
}

func NewSSHFileService(pool *sshmgr.FilePool) *SSHFileService {
	return &SSHFileService{pool: pool, listings: newSSHListingCache()}
}

// sshPathListing is one connection's complete set of searchable remote
// paths, relative to its home directory: every file, and every directory
// (trailing-slash-suffixed, per FileQuickOpen's isDirectoryResult
// contract). Both halves are always collected together so a quick-open
// search and a files-only search share one cache entry instead of each
// forcing its own remote walk.
type sshPathListing struct {
	files []string
	dirs  []string
}

// sshListingEntry caches one connection's listing. Its mutex doubles as a
// single-flight guard: concurrent Search calls for the same connection
// queue behind whichever one is collecting, then all read the fresh result,
// so a burst of keystrokes can never fan out into a burst of remote finds.
type sshListingEntry struct {
	mu        sync.Mutex
	listing   sshPathListing
	collected time.Time
	valid     bool
}

type sshListingCache struct {
	mu      sync.Mutex
	entries map[string]*sshListingEntry
}

func newSSHListingCache() *sshListingCache {
	return &sshListingCache{entries: make(map[string]*sshListingEntry)}
}

func (c *sshListingCache) entry(connectionID string) *sshListingEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[connectionID]
	if !ok {
		entry = &sshListingEntry{}
		c.entries[connectionID] = entry
	}
	return entry
}

// invalidate drops connectionID's cached listing so the next Search
// re-collects it. Called by every operation that changes which paths exist
// (write, mkdir, move, copy, delete, upload) so an operator never has to
// wait out sshListingTTL to find a file DevDeck itself just created.
func (c *sshListingCache) invalidate(connectionID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, connectionID)
}

// absPath resolves clean (already normalizeRelativePath'd) against the
// connection's home directory. The home lookup goes through
// sshmgr.FilePool.Home, which resolves it once per live connection and
// caches it on the pool entry — previously this cost one SFTP REALPATH
// round trip on every single file operation, which on a high-latency link
// is a whole extra round trip per list/open/save. Invalidation is handled
// for free by the pool: the cached value is tied to the specific SFTP
// client it came from, so an evicted-and-redialed connection re-resolves.
func (svc *SSHFileService) absPath(ctx context.Context, connectionID, clean string) (string, error) {
	home, err := svc.pool.Home(ctx, connectionID)
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
		abs, err := svc.absPath(ctx, connectionID, clean)
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
// pooled SSH connection and returns each printed path relative to
// homePrefix (directories trailing-slash-suffixed).
//
// A nonzero find exit status (e.g. one permission-denied subdirectory among
// many readable ones) is not treated as fatal — whatever it printed to
// stdout before that is still used, mirroring the old walker's "skip
// permission-denied entries, keep going" behavior. A run that produced *no*
// output at all, though, is reported as an error rather than silently
// returning an empty listing: that is what a genuine failure looks like
// (find missing from PATH, the search budget expiring, sshd refusing
// another channel), and swallowing it made a broken remote search
// indistinguishable in the UI from a home directory with nothing in it.
func listRemotePaths(
	ctx context.Context,
	pool *sshmgr.FilePool,
	connectionID, root, homePrefix string,
	wantDirs bool,
) ([]string, error) {
	stdout, stderr, runErr := sshmgr.RunCommand(ctx, pool, connectionID, findListArgs(root, wantDirs))
	if runErr != nil && len(bytes.TrimSpace(stdout)) == 0 {
		return nil, listRemotePathsError(stderr, runErr)
	}

	paths := make([]string, 0, 256)
	scanner := bufio.NewScanner(bytes.NewReader(stdout))
	scanner.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		relative := strings.TrimPrefix(line, homePrefix)
		if wantDirs {
			relative += "/"
		}
		paths = append(paths, relative)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("search files failed")
	}
	return paths, nil
}

// listRemotePathsError turns a failed remote `find` into a message the
// operator can act on, preferring the remote's own stderr (e.g. "find:
// command not found") over a bare exit code, and naming the timeout case
// explicitly since that is the one a huge remote home directory produces.
func listRemotePathsError(stderr []byte, runErr error) error {
	// Deliberately not wrapped in ErrValidation: a timeout is the server
	// giving up on the remote host, not a bad request, so it should surface
	// as a 500 carrying this message rather than a 400.
	if errors.Is(runErr, context.DeadlineExceeded) {
		return fmt.Errorf("listing remote files timed out after %s — the remote home directory may be very large", sshSearchBudget)
	}
	if detail := strings.TrimSpace(string(stderr)); detail != "" {
		return fmt.Errorf("list remote files failed: %s", firstStderrLine(detail))
	}
	return fmt.Errorf("list remote files failed")
}

func firstStderrLine(s string) string {
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		return strings.TrimSpace(s[:idx])
	}
	return s
}

// listing returns connectionID's remote path listing, collecting it via
// `find` only when there is no fresh cached copy (see sshListingTTL for why
// caching is what makes remote quick-open usable at all). Files and
// directories are collected concurrently: they are two independent remote
// walks, so running them together halves the latency an operator waits on a
// cold cache, and two channels is well inside any sshd's session budget.
func (svc *SSHFileService) listing(ctx context.Context, connectionID string) (sshPathListing, error) {
	entry := svc.listings.entry(connectionID)
	entry.mu.Lock()
	defer entry.mu.Unlock()

	if entry.valid && time.Since(entry.collected) < sshListingTTL {
		return entry.listing, nil
	}

	ctx, cancel := context.WithTimeout(ctx, sshSearchBudget)
	defer cancel()

	home, err := svc.pool.Home(ctx, connectionID)
	if err != nil {
		return sshPathListing{}, fmt.Errorf("resolve home directory failed")
	}
	homePrefix := strings.TrimSuffix(home, "/") + "/"

	var (
		wg                sync.WaitGroup
		files, dirs       []string
		filesErr, dirsErr error
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		files, filesErr = listRemotePaths(ctx, svc.pool, connectionID, home, homePrefix, false)
	}()
	go func() {
		defer wg.Done()
		dirs, dirsErr = listRemotePaths(ctx, svc.pool, connectionID, home, homePrefix, true)
	}()
	wg.Wait()

	if filesErr != nil {
		return sshPathListing{}, filesErr
	}
	if dirsErr != nil {
		return sshPathListing{}, dirsErr
	}

	entry.listing = sshPathListing{files: files, dirs: dirs}
	entry.collected = time.Now()
	entry.valid = true
	return entry.listing, nil
}

// Search returns remote file paths matched by the same fuzzy/regex matcher
// as WorktreeFileService.Search (shared filePathMatcher, searchSkipDirs,
// maxFileSearchResults — defined in worktree_file.go, same package).
//
// The remote host is only ever asked for the *unfiltered* listing (see
// listing/sshListingTTL) — the pattern has always been applied in Go, so
// re-walking the remote tree per keystroke bought nothing and cost
// everything. Matching therefore runs entirely against the cached listing,
// which makes a keystroke's worth of work an in-memory scan rather than a
// remote filesystem walk.
func (svc *SSHFileService) Search(ctx context.Context, connectionID, pattern string, includeDirs bool) ([]string, error) {
	listing, err := svc.listing(ctx, connectionID)
	if err != nil {
		return nil, err
	}

	matcher := newFilePathMatcher(pattern)
	matches := make([]fileSearchMatch, 0, maxFileSearchResults)
	for _, file := range listing.files {
		addFileSearchMatch(&matches, matcher, file, false)
	}
	if includeDirs {
		for _, dir := range listing.dirs {
			addFileSearchMatch(&matches, matcher, dir, true)
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

	home, err := svc.pool.Home(ctx, connectionID)
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
		abs, err := svc.absPath(ctx, connectionID, clean)
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
		// io.Copy, not io.ReadAll: sftp.File implements io.WriterTo, whose
		// WriteTo pipelines many read requests concurrently, and io.Copy
		// picks that up automatically. io.ReadAll instead calls Read against
		// a buffer that starts at 512 bytes and grows, so every one of those
		// small reads was a separate serial SFTP round trip — dozens of them
		// for an ordinary source file, which is what made opening a remote
		// file in the editor take seconds on any non-LAN connection. Download
		// (below) already had this right; Read did not.
		var buf bytes.Buffer
		buf.Grow(int(info.Size()) + bytes.MinRead)
		if _, err := io.Copy(&buf, file); err != nil {
			return SSHFileContent{}, fileOperationError("read file", clean, err)
		}
		data := buf.Bytes()
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
		abs, err := svc.absPath(ctx, connectionID, clean)
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
	result, err := sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (SSHFileContent, error) {
		abs, err := svc.absPath(ctx, connectionID, clean)
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
	if err == nil {
		svc.listings.invalidate(connectionID)
	}
	return result, err
}

// Mkdir creates an empty remote folder — SSH counterpart to
// WorktreeFileService.Mkdir, using sftp's MkdirAll instead of os.MkdirAll.
func (svc *SSHFileService) Mkdir(ctx context.Context, connectionID, relativePath string) (SSHFileEntry, error) {
	clean, err := normalizeRelativePath(relativePath, false)
	if err != nil {
		return SSHFileEntry{}, err
	}
	result, err := sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (SSHFileEntry, error) {
		abs, err := svc.absPath(ctx, connectionID, clean)
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
	if err == nil {
		svc.listings.invalidate(connectionID)
	}
	return result, err
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
	result, err := sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (SSHFileEntry, error) {
		fromAbs, err := svc.absPath(ctx, connectionID, fromClean)
		if err != nil {
			return SSHFileEntry{}, err
		}
		toAbs, err := svc.absPath(ctx, connectionID, toClean)
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
	if err == nil {
		svc.listings.invalidate(connectionID)
	}
	return result, err
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
	result, err := sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (SSHFileEntry, error) {
		fromAbs, err := svc.absPath(ctx, connectionID, fromClean)
		if err != nil {
			return SSHFileEntry{}, err
		}
		toAbs, err := svc.absPath(ctx, connectionID, toClean)
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
	if err == nil {
		svc.listings.invalidate(connectionID)
	}
	return result, err
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
		abs, err := svc.absPath(ctx, connectionID, clean)
		if err != nil {
			return struct{}{}, err
		}
		if err := client.Remove(abs); err != nil {
			return struct{}{}, fileOperationError("delete file", clean, err)
		}
		return struct{}{}, nil
	})
	if err == nil {
		svc.listings.invalidate(connectionID)
	}
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
	result, err := sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) ([]SSHFileEntry, error) {
		absDir, err := svc.absPath(ctx, connectionID, cleanDir)
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
	if err == nil {
		svc.listings.invalidate(connectionID)
	}
	return result, err
}

func (svc *SSHFileService) DeleteMany(ctx context.Context, connectionID string, paths []string) error {
	pruned, err := cleanAndPruneSelection(paths, nil)
	if err != nil {
		return err
	}
	_, err = sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (struct{}, error) {
		for _, clean := range pruned {
			abs, err := svc.absPath(ctx, connectionID, clean)
			if err != nil {
				return struct{}{}, err
			}
			if err := client.RemoveAll(abs); err != nil {
				return struct{}{}, fileOperationError("delete file", clean, err)
			}
		}
		return struct{}{}, nil
	})
	if err == nil {
		svc.listings.invalidate(connectionID)
	}
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
			abs, err := svc.absPath(ctx, connectionID, clean)
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
