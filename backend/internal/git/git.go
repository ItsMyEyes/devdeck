// Package git wraps the git CLI for worktree branch operations. All commands
// use exec.Command with an argument slice — never a shell string — so there
// is no shell-injection surface. Branch/base names are additionally
// validated so a crafted name can't be interpreted as a git flag.
package git

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var refNamePattern = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

// validRef reports whether name is safe to pass as a git ref argument.
func validRef(name string) bool {
	return name != "" && !strings.HasPrefix(name, "-") && refNamePattern.MatchString(name)
}

// expandHome expands a leading ~ to the user's home directory. git -C (and
// os/exec generally) never does shell-style tilde expansion, so a project
// path stored verbatim as "~/code/foo" would otherwise fail with "cannot
// change to '~/code/foo': No such file or directory".
func expandHome(path string) string {
	if !strings.HasPrefix(path, "~") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return filepath.Join(home, strings.TrimPrefix(path, "~"))
}

func run(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return stdout.String(), nil
}

// ListBranches returns the local branch names of the repository at repoPath.
func ListBranches(repoPath string) ([]string, error) {
	out, err := run("-C", expandHome(repoPath), "branch", "--format=%(refname:short)")
	if err != nil {
		return nil, err
	}
	var branches []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			branches = append(branches, line)
		}
	}
	return branches, nil
}

// AddWorktree creates a new git worktree at worktreePath, checking out a new
// branch named branch created from base.
func AddWorktree(repoPath, worktreePath, branch, base string) error {
	if !validRef(branch) {
		return fmt.Errorf("invalid branch name %q", branch)
	}
	if !validRef(base) {
		return fmt.Errorf("invalid base branch name %q", base)
	}
	_, err := run("-C", expandHome(repoPath), "worktree", "add", "-b", branch, expandHome(worktreePath), base)
	return err
}

// RemoveWorktree removes the git worktree at worktreePath from repoPath's
// registry, discarding any modified or untracked files inside it. It is
// idempotent: if worktreePath isn't a registered worktree, it returns nil
// rather than an error. Force is safe here — by the time this runs, the
// caller (WorktreeService.Delete) has already committed to deleting the
// worktree's DB row, so a leftover dirty working tree must not block that;
// it would otherwise leave the database and disk out of sync.
func RemoveWorktree(repoPath, worktreePath string) error {
	_, err := run("-C", expandHome(repoPath), "worktree", "remove", "--force", expandHome(worktreePath))
	if err != nil && strings.Contains(err.Error(), "is not a working tree") {
		return nil
	}
	return err
}

// Checkout switches worktreePath's checked-out branch to branch, which must
// already exist in the repository.
func Checkout(worktreePath, branch string) error {
	if !validRef(branch) {
		return fmt.Errorf("invalid branch name %q", branch)
	}
	_, err := run("-C", expandHome(worktreePath), "checkout", branch)
	return err
}
