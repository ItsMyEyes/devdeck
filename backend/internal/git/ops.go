package git

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const (
	localOpTimeout   = 15 * time.Second
	networkOpTimeout = 60 * time.Second
)

// StatusFile is one changed path in a worktree, as reported by git status.
type StatusFile struct {
	Path     string `json:"path"`
	OrigPath string `json:"origPath,omitempty"` // rename/copy source
	Index    string `json:"index"`              // staged status letter ("M", "A", "D", "R", ".")
	Worktree string `json:"worktree"`           // unstaged status letter ("M", "D", "?", ".")
}

// Status is the uncommitted state of a worktree plus its branch position.
type Status struct {
	Branch   string       `json:"branch"`
	Upstream string       `json:"upstream"`
	Ahead    int          `json:"ahead"`
	Behind   int          `json:"behind"`
	Files    []StatusFile `json:"files"`
}

// Commit is one entry of the history log.
type Commit struct {
	Hash    string   `json:"hash"`
	Short   string   `json:"short"`
	Author  string   `json:"author"`
	Date    string   `json:"date"` // ISO-8601 author date
	Subject string   `json:"subject"`
	Refs    []string `json:"refs"` // branch/tag decorations, empty when none
}

// runDir executes git inside dir with a timeout. Network operations must not
// hang on credential prompts, so terminal prompting is disabled globally.
func runDir(dir string, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return "", fmt.Errorf("git %s timed out", args[0])
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("%s", msg)
	}
	return stdout.String(), nil
}

// WorktreeStatus reports branch position and all uncommitted files of the
// repository at dir, parsed from porcelain v2 (stable scripting format).
func WorktreeStatus(dir string) (Status, error) {
	out, err := runDir(dir, localOpTimeout, "status", "--porcelain=v2", "--branch", "-z")
	if err != nil {
		return Status{}, err
	}
	status := Status{Files: []StatusFile{}}
	fields := strings.Split(out, "\x00")
	for i := 0; i < len(fields); i++ {
		line := fields[i]
		if line == "" {
			continue
		}
		switch {
		case strings.HasPrefix(line, "# branch.head "):
			status.Branch = strings.TrimPrefix(line, "# branch.head ")
		case strings.HasPrefix(line, "# branch.upstream "):
			status.Upstream = strings.TrimPrefix(line, "# branch.upstream ")
		case strings.HasPrefix(line, "# branch.ab "):
			parts := strings.Fields(strings.TrimPrefix(line, "# branch.ab "))
			if len(parts) == 2 {
				status.Ahead, _ = strconv.Atoi(strings.TrimPrefix(parts[0], "+"))
				status.Behind, _ = strconv.Atoi(strings.TrimPrefix(parts[1], "-"))
			}
		case strings.HasPrefix(line, "1 "):
			parts := strings.SplitN(line, " ", 9)
			if len(parts) == 9 {
				status.Files = append(status.Files, StatusFile{
					Path:     parts[8],
					Index:    string(parts[1][0]),
					Worktree: string(parts[1][1]),
				})
			}
		case strings.HasPrefix(line, "2 "):
			// Rename/copy: the entry's path field is followed by a separate
			// NUL-terminated original path.
			parts := strings.SplitN(line, " ", 10)
			if len(parts) == 10 && i+1 < len(fields) {
				status.Files = append(status.Files, StatusFile{
					Path:     parts[9],
					OrigPath: fields[i+1],
					Index:    string(parts[1][0]),
					Worktree: string(parts[1][1]),
				})
				i++
			}
		case strings.HasPrefix(line, "u "):
			parts := strings.SplitN(line, " ", 11)
			if len(parts) == 11 {
				status.Files = append(status.Files, StatusFile{
					Path:     parts[10],
					Index:    "U",
					Worktree: "U",
				})
			}
		case strings.HasPrefix(line, "? "):
			status.Files = append(status.Files, StatusFile{
				Path:     strings.TrimPrefix(line, "? "),
				Index:    ".",
				Worktree: "?",
			})
		}
	}
	return status, nil
}

// DiffFile returns the unified diff of one path: staged (index vs HEAD) or
// unstaged (worktree vs index). Untracked files diff against /dev/null.
func DiffFile(dir, path string, staged, untracked bool) (string, error) {
	if untracked {
		// --no-index exits 1 when the files differ; that is the expected case.
		return runDirTolerant(dir, "diff", "--no-index", "--", os.DevNull, path)
	}
	args := []string{"diff"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", path)
	return runDir(dir, localOpTimeout, args...)
}

// runDirTolerant runs git and accepts exit status 1 with output as success
// (diff --no-index semantics: 1 means "differences found").
func runDirTolerant(dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), localOpTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil || stdout.Len() > 0 {
		return stdout.String(), nil
	}
	msg := strings.TrimSpace(stderr.String())
	if msg == "" {
		msg = err.Error()
	}
	return "", fmt.Errorf("%s", msg)
}

// ShowCommit returns the full patch of one commit.
func ShowCommit(dir, hash string) (string, error) {
	if !validRef(hash) {
		return "", fmt.Errorf("invalid commit hash %q", hash)
	}
	// No --stat: the client builds its files-changed summary from the patch.
	return runDir(dir, localOpTimeout, "show", "--patch", "--format=medium", hash)
}

// Stage adds the given paths to the index.
func Stage(dir string, paths []string) error {
	args := append([]string{"add", "--"}, paths...)
	_, err := runDir(dir, localOpTimeout, args...)
	return err
}

// Unstage removes the given paths from the index, keeping worktree changes.
func Unstage(dir string, paths []string) error {
	args := append([]string{"reset", "-q", "HEAD", "--"}, paths...)
	_, err := runDir(dir, localOpTimeout, args...)
	if err != nil && strings.Contains(err.Error(), "unknown revision") {
		// Repository has no commits yet: unstage means removing from the index.
		args = append([]string{"rm", "--cached", "-q", "--"}, paths...)
		_, err = runDir(dir, localOpTimeout, args...)
	}
	return err
}

// Discard reverts worktree changes: tracked paths are restored from the
// index, untracked paths are removed (VS Code's discard semantics).
func Discard(dir string, tracked, untracked []string) error {
	if len(tracked) > 0 {
		args := append([]string{"restore", "--worktree", "--"}, tracked...)
		if _, err := runDir(dir, localOpTimeout, args...); err != nil {
			return err
		}
	}
	if len(untracked) > 0 {
		args := append([]string{"clean", "-f", "--"}, untracked...)
		if _, err := runDir(dir, localOpTimeout, args...); err != nil {
			return err
		}
	}
	return nil
}

// CommitStaged records the staged changes with the given message.
func CommitStaged(dir, message string) error {
	_, err := runDir(dir, localOpTimeout, "commit", "-m", message)
	return err
}

// Push publishes the current branch. When it has no upstream yet, the branch
// is pushed to origin with upstream tracking, matching VS Code's behavior.
func Push(dir string) (string, error) {
	out, err := runDir(dir, networkOpTimeout, "push")
	if err != nil && strings.Contains(err.Error(), "no upstream branch") {
		return runDir(dir, networkOpTimeout, "push", "-u", "origin", "HEAD")
	}
	return out, err
}

// Pull fetches and integrates the upstream branch without opening an editor.
func Pull(dir string) (string, error) {
	return runDir(dir, networkOpTimeout, "pull", "--no-edit")
}

// Log returns the most recent commits with their ref decorations.
func Log(dir string, limit int) ([]Commit, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	format := "%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%D%x1e"
	out, err := runDir(dir, localOpTimeout, "log", "-n", strconv.Itoa(limit), "--pretty=format:"+format)
	if err != nil {
		if strings.Contains(err.Error(), "does not have any commits yet") {
			return []Commit{}, nil
		}
		return nil, err
	}
	commits := []Commit{}
	for _, record := range strings.Split(out, "\x1e") {
		record = strings.TrimSpace(record)
		if record == "" {
			continue
		}
		parts := strings.Split(record, "\x1f")
		if len(parts) != 6 {
			continue
		}
		refs := []string{}
		for _, ref := range strings.Split(parts[5], ", ") {
			ref = strings.TrimSpace(ref)
			if ref != "" {
				refs = append(refs, ref)
			}
		}
		commits = append(commits, Commit{
			Hash:    parts[0],
			Short:   parts[1],
			Author:  parts[2],
			Date:    parts[3],
			Subject: parts[4],
			Refs:    refs,
		})
	}
	return commits, nil
}
