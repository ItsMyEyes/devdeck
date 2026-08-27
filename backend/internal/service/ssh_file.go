package service

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path"
	"sort"
	"strconv"
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
//
// A var rather than a const purely so tests can shrink it — same
// reassign-in-test pattern as installRipgrepOverSSH below; nothing in
// production ever writes it.
var sshSearchBudget = 20 * time.Second

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
//
// Now that a collection is one pruned traversal
// rather than two unpruned ones (roughly three seconds on a real developer
// home directory, against a walk that previously could not finish inside
// sshSearchBudget at all), the dominant remaining cost of remote search is
// how often that traversal repeats. Every DevDeck-initiated change to the
// remote tree already invalidates this cache explicitly (see invalidate
// below), so the TTL only bounds staleness from changes made *outside*
// DevDeck — a git pull in the SSH shell, say. Two minutes keeps that lag
// short while cutting cold-collection frequency fourfold versus the previous
// 30 seconds.
const sshListingTTL = 2 * time.Minute

// sshListingByteCap bounds how many bytes of `find` output one collection may
// consume, enforced remotely via `head -c` (see collectRemoteListing) so the
// remote walk is stopped by SIGPIPE rather than merely truncated after the
// cost has already been paid.
//
// This is a backstop against a pathological remote tree, NOT a working limit:
// a cap that binds in normal use would silently drop files from quick-open,
// which is the same class of bug as the silently-truncated timeout this change
// exists to fix. Sized against measurement, not guesswork — a heavily
// populated real developer home directory yields ~30 MB / ~230k paths once
// sshSearchSkipDirs has pruned the caches, so 64 MiB leaves better than 2x
// headroom before truncation is even possible, and a collection that does hit
// it is logged rather than passed off as complete.
const sshListingByteCap = 64 << 20

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
		// Wrapped, not flattened, for the reason opError exists: this runs
		// inside every WithSFTPClient callback, and on a connection that died
		// since it was pooled the Getwd behind Home is the FIRST thing to
		// fail — before the ReadDir/Open the operation was actually about. A
		// bare error here would hide the dead connection from the evict-and-
		// redial check just as effectively as flattening it later would.
		return "", &opError{message: "resolve home directory failed", cause: err}
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

// sshSearchSkipDirs is the set of directory names pruned from an SSH
// connection's remote listing. It is deliberately *not* searchSkipDirs (the
// worktree set) but a superset of it, because the two searches are rooted at
// wildly different scales: a worktree search starts at one project checkout,
// whereas an SSH search starts at the operator's entire home directory.
//
// That difference is the whole reason remote search was unusable. Measured on
// a real developer home directory, the worktree-tuned prune set left ~508k
// files still to walk and the traversal did not finish inside sshSearchBudget
// at all; the entries added below — language toolchain caches (go/pkg/mod via
// `pkg`, .cargo, .rustup, .nvm, .npm, .bun, .m2, .gradle), OS/app caches
// (Library, .cache, AppData), and virtualenv/build noise — brought the same
// tree to ~130k entries in about 3 seconds. None of these hold files an
// operator would ever quick-open; they are pure traversal cost.
//
// searchSkipDirs is left untouched on purpose: it also drives worktree search
// and both grep argument builders, where pruning names like `target` or
// `Library` would silently change what a project-scoped search can find.
var sshSearchSkipDirs = func() map[string]bool {
	skip := map[string]bool{
		// Language/package-manager caches.
		"pkg": true, ".cargo": true, ".rustup": true, ".nvm": true,
		".npm": true, ".bun": true, ".deno": true, ".yarn": true,
		".pnpm-store": true, ".m2": true, ".gradle": true, ".stack": true,
		".ivy2": true, ".sbt": true, ".gem": true, ".pyenv": true, ".rbenv": true,
		// OS / application caches and state.
		"Library": true, "AppData": true, ".cache": true, ".Trash": true,
		"snap": true, ".vscode-server": true, ".cursor-server": true,
		// Python virtualenv / tool caches.
		".venv": true, "venv": true, "__pycache__": true, ".tox": true,
		".mypy_cache": true, ".pytest_cache": true, ".ruff_cache": true,
		// Infrastructure state.
		".terraform": true,
	}
	for dir := range searchSkipDirs {
		skip[dir] = true
	}
	return skip
}()

// findListingArgs builds a `find <root> ...` argv that lists every file *and*
// every directory under root in a **single traversal**, NUL-delimited, with
// directories distinguished by a trailing slash (per FileQuickOpen's
// isDirectoryResult contract).
//
// One traversal, not two: the previous implementation ran a `-type f` find and
// a `-type d` find concurrently, which walked the identical tree twice and
// paid twice the remote I/O to produce two halves of one listing. Emitting
// both from one walk halves the cost outright.
//
// NUL delimiting, not newlines: a path containing a newline would otherwise
// split into two bogus listing entries. `-print0` and `printf '%s/\0'` are
// both available on GNU, BSD and busybox find/printf. The format string is a
// fixed literal and every path arrives as an *argument* to printf, so a `%`
// in a filename is data, never a conversion specifier. `-exec ... +` batches
// many paths per printf invocation, so this costs a handful of execs for the
// whole walk rather than one per directory.
//
// `-mindepth 1` excludes root itself, matching the old walker's "skip the
// starting entry" check. find's default (non `-L`) `-type f`/`-type d` tests
// never match a symlink (its own type is `l`), so symlinks are skipped for
// free, mirroring the old walker's explicit os.ModeSymlink check. Only
// skip-dir names and the (server-controlled) root path go into this command —
// the user-supplied search pattern never does; matching happens entirely in Go
// afterward via filePathMatcher, so there is no shell-injection surface here
// the way there is for Grep's query/includePattern.
func findListingArgs(root string) []string {
	skipDirs := make([]string, 0, len(sshSearchSkipDirs))
	for dir := range sshSearchSkipDirs {
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
	return append(args,
		"(",
		"-type", "d", "-exec", "printf", `%s/\0`, "{}", "+",
		"-o",
		"-type", "f", "-print0",
		")",
	)
}

// collectRemoteListing runs findListingArgs(root) over connectionID's pooled
// SSH connection and splits its NUL-delimited output into files and
// directories, each path relative to homePrefix.
//
// The walk is capped *on the remote side* by piping it through
// `head -c sshListingByteCap`: when the cap is reached head exits, find takes
// SIGPIPE and stops walking, so neither the remote I/O nor the bytes on the
// wire can grow without bound on a pathological home directory. Truncation is
// detected here by the output having reached the cap, since a pipeline's exit
// status is head's and therefore says nothing about the upstream find.
//
// A nonzero find exit status (e.g. one permission-denied subdirectory among
// many readable ones) is not treated as fatal — whatever it printed to stdout
// before that is still used, mirroring the old walker's "skip
// permission-denied entries, keep going" behavior.
//
// A timeout, however, is now always an error, even when partial output was
// captured. Silently returning the prefix of the tree that find happened to
// emit before the budget expired was the single most user-visible half of the
// "remote search is broken" bug: the operator typed a filename they knew
// existed, the listing had been cut off long before reaching it, and the UI
// reported a clean "no results" that was indistinguishable from the file not
// being there. An explicit, actionable error is strictly better than a
// confidently wrong empty list.
func collectRemoteListing(
	ctx context.Context,
	pool *sshmgr.FilePool,
	connectionID, root, homePrefix string,
) (sshPathListing, error) {
	stdout, stderr, runErr := sshmgr.RunPipeline(ctx, pool, connectionID, [][]string{
		findListingArgs(root),
		{"head", "-c", strconv.Itoa(sshListingByteCap)},
	})
	if runErr != nil && (errors.Is(runErr, context.DeadlineExceeded) || len(bytes.TrimSpace(stdout)) == 0) {
		return sshPathListing{}, collectRemoteListingError(stderr, runErr)
	}

	// Hitting the cap cannot be detected from the exit status (a pipeline
	// reports head's, which is a clean 0), so it is detected from the output
	// length. A truncated run's final record is very likely a path cut in
	// half, so drop everything after the last complete (NUL-terminated)
	// record rather than surfacing a mangled path.
	if len(stdout) >= sshListingByteCap {
		log.Printf(
			"ssh search: connection %s listing hit the %d MiB cap and is incomplete — remote home directory is unusually large",
			connectionID, sshListingByteCap>>20,
		)
		if last := bytes.LastIndexByte(stdout, 0); last >= 0 {
			stdout = stdout[:last+1]
		}
	}

	listing := sshPathListing{
		files: make([]string, 0, 1024),
		dirs:  make([]string, 0, 256),
	}
	for _, record := range bytes.Split(stdout, []byte{0}) {
		if len(record) == 0 {
			continue
		}
		relative := strings.TrimPrefix(string(record), homePrefix)
		if relative == "" {
			continue
		}
		if strings.HasSuffix(relative, "/") {
			listing.dirs = append(listing.dirs, relative)
			continue
		}
		listing.files = append(listing.files, relative)
	}
	return listing, nil
}

// collectRemoteListingError turns a failed remote `find` into a message the
// operator can act on, preferring the remote's own stderr (e.g. "find:
// command not found") over a bare exit code, and naming the timeout case
// explicitly since that is the one a huge remote home directory produces.
func collectRemoteListingError(stderr []byte, runErr error) error {
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
// caching is what makes remote quick-open usable at all).
//
// Files and directories come back from one traversal (findListingArgs), not
// from two concurrent walks of the same tree as before — see that function
// for why walking twice was pure waste.
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

	listing, err := collectRemoteListing(ctx, svc.pool, connectionID, home, homePrefix)
	if err != nil {
		return sshPathListing{}, err
	}

	entry.listing = listing
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

// Extract decodes a zip archive read from r and writes its entries beneath
// destFolder over SFTP — the inverse of Archive, and the SSH counterpart of
// WorktreeFileService.Extract. Every entry is validated by the shared
// planZipExtraction (zip_extract.go) — normalizeRelativePath's zip-slip
// guard, a symlink-entry rejection, and the entry-count/uncompressed-size
// budgets — entirely before anything is written, so a rejected archive can
// never leave a partially-extracted destFolder behind. Unlike the worktree
// version, entries are decoded here in Go and written one at a time over the
// already-open pooled SFTP connection this service uses for Upload — there
// is deliberately no dependency on an `unzip` binary existing on the remote
// host.
func (svc *SSHFileService) Extract(ctx context.Context, connectionID, destFolder string, r io.Reader) ([]SSHFileEntry, error) {
	cleanDir, err := normalizeRelativePath(destFolder, true)
	if err != nil {
		return nil, err
	}

	// archive/zip.NewReader needs random access to find the central
	// directory at the end of the stream, so the upload is spooled to a
	// temp file rather than buffered in memory — mirrors
	// WorktreeFileService.Extract's identical requirement.
	tmp, err := os.CreateTemp("", "devdeck-ssh-extract-*.zip")
	if err != nil {
		return nil, fmt.Errorf("read archive failed")
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	size, err := io.Copy(tmp, r)
	if err != nil {
		return nil, fmt.Errorf("read archive failed")
	}
	zr, err := zip.NewReader(tmp, size)
	if err != nil {
		return nil, fmt.Errorf("invalid zip archive: %w", ErrValidation)
	}
	if len(zr.File) > maxExtractEntries {
		return nil, fmt.Errorf("archive has more than %d entries: %w", maxExtractEntries, ErrValidation)
	}

	plan, err := planZipExtraction(zr.File)
	if err != nil {
		return nil, err
	}

	// Invalidate the cached listing unconditionally once the plan has
	// validated: a mid-write failure can leave hundreds of files already
	// on the host, and a stale listing would hide them from FileQuickOpen
	// and Search for up to sshListingTTL. The other mutating methods share
	// the success-only pattern, but Extract writes far more entries per
	// call, so a partial write is far more likely here.
	defer svc.listings.invalidate(connectionID)

	result, err := sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) ([]SSHFileEntry, error) {
		absDir, err := svc.absPath(ctx, connectionID, cleanDir)
		if err != nil {
			return nil, err
		}
		info, err := client.Stat(absDir)
		if err != nil {
			return nil, fileOperationError("inspect extract folder", cleanDir, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("%q is not a folder: %w", cleanDir, ErrValidation)
		}

		entries := make([]SSHFileEntry, 0, len(plan))
		for _, item := range plan {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			entryPath := path.Join(cleanDir, item.relative)
			abs := path.Join(absDir, item.relative)
			if item.isDir {
				if err := client.MkdirAll(abs); err != nil {
					return nil, fileOperationError("create folder", entryPath, err)
				}
				entries = append(entries, SSHFileEntry{Name: path.Base(entryPath), Path: entryPath, IsDir: true})
				continue
			}
			if err := client.MkdirAll(path.Dir(abs)); err != nil {
				return nil, fileOperationError("create folder", path.Dir(entryPath), err)
			}
			if err := extractRemoteZipEntry(client, item.zipFile, abs); err != nil {
				return nil, fileOperationError("write file", entryPath, err)
			}
			written, err := client.Stat(abs)
			if err != nil {
				return nil, fileOperationError("inspect extracted file", entryPath, err)
			}
			entries = append(entries, SSHFileEntry{Name: path.Base(entryPath), Path: entryPath, IsDir: false, Size: written.Size()})
		}
		return entries, nil
	})
	return result, err
}

// extractRemoteZipEntry writes one non-directory zip entry's decompressed
// content to abs over the pooled SFTP client — the remote counterpart of
// worktree_file.go's extractZipEntry. There is no permission-bit
// preservation here (unlike the local version's zf.Mode().Perm()): Upload,
// above, doesn't preserve uploaded files' modes either, so this keeps
// Extract consistent with how every other SSH write in this file already
// behaves rather than introducing a one-off exception.
func extractRemoteZipEntry(client *sftp.Client, zf *zip.File, abs string) error {
	rc, err := zf.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := client.Create(abs)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, rc)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}
