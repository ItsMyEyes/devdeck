package detect

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// AugmentedEnv returns the current process environment with PATH extended by
// the same directories ResolveBinary probes when exec.LookPath comes up empty.
//
// ResolveBinary already compensates for the backend's minimal PATH on its own
// behalf — see goBinDir's comment: a GUI-launched or service-managed backend
// does not inherit a login shell's exports, so `go install`-ed tools are
// invisible to a bare LookPath. But finding a binary is only half the problem.
// A language server found that way is then started as a child process, and a
// child inherits the parent's environment verbatim unless Cmd.Env is set. So
// gopls would be located successfully and then fail its own internal lookup of
// the `go` binary, because the PATH it inherited is the same minimal one that
// made ResolveBinary's fallback necessary in the first place.
//
// A gopls that cannot run `go list` does not fail loudly. It degrades to
// loading each file as a standalone "command-line-arguments" package, which
// reports every symbol defined in a sibling file of the same package as
// undefined, and rejects an import of the module's own internal/ tree with
// "use of internal package ... not allowed" — because an ad-hoc package is not
// considered part of the module that owns it.
//
// Pass this to Cmd.Env for any child process that shells out to a toolchain.
func AugmentedEnv() []string {
	return augmentEnv(os.Environ(), append(fallbackDirs(), shellPathDirs()...))
}

// pathKey is the environment variable name holding the executable search path.
// Windows spells it "Path" and compares names case-insensitively; every other
// platform uses exactly "PATH".
func pathKey(name string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(name, "PATH")
	}
	return name == "PATH"
}

// augmentEnv is the pure half of AugmentedEnv, so the merge rules can be tested
// without touching the real environment or the user's login shell.
func augmentEnv(env []string, extra []string) []string {
	out := make([]string, 0, len(env)+1)
	merged := false

	for _, entry := range env {
		name, value, found := strings.Cut(entry, "=")
		if !found || !pathKey(name) {
			out = append(out, entry)
			continue
		}
		out = append(out, name+"="+augmentPath(value, extra))
		merged = true
	}

	// A process started with an empty environment has no PATH to extend, but
	// still needs one — otherwise the child has no search path at all.
	if !merged {
		out = append(out, "PATH="+augmentPath("", extra))
	}
	return out
}

// augmentPath appends extra to current, preserving current's order and
// precedence: an entry already on PATH keeps its original position, so this
// never shadows a toolchain the user deliberately put first. Empty and
// duplicate entries are dropped.
func augmentPath(current string, extra []string) string {
	separator := string(os.PathListSeparator)

	var ordered []string
	seen := make(map[string]struct{})

	add := func(dir string) {
		if dir == "" {
			return
		}
		key := dir
		if runtime.GOOS == "windows" {
			key = strings.ToLower(dir)
		}
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		ordered = append(ordered, dir)
	}

	for _, dir := range strings.Split(current, separator) {
		add(dir)
	}
	for _, dir := range extra {
		// Cleaning must come after the empty check, not before: filepath.Clean("")
		// is ".", so cleaning first would silently put the child process's working
		// directory on its PATH.
		if dir == "" {
			continue
		}
		add(filepath.Clean(dir))
	}

	return strings.Join(ordered, separator)
}
