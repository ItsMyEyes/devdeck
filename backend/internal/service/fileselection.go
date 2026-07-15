package service

import (
	"fmt"
	"sort"
	"strings"
)

// cleanAndPruneSelection normalizes a batch-operation path list (delete
// selection, zip selection, ...): validates and dedupes each entry, then
// drops any path already covered by an ancestor also in the list (selecting
// both "src" and "src/main.go" should only walk "src" once). reject, if
// non-nil, rejects additional path shapes beyond normalizeRelativePath's own
// checks (e.g. worktree's reserved ".git"/".wt" segments) — pass nil where
// there's nothing extra to reject (e.g. an SSH connection's remote
// filesystem has no reserved segments of its own).
func cleanAndPruneSelection(paths []string, reject func(clean string) error) ([]string, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("at least one path is required: %w", ErrValidation)
	}
	cleaned := make([]string, 0, len(paths))
	seen := make(map[string]bool, len(paths))
	for _, raw := range paths {
		clean, err := normalizeRelativePath(raw, false)
		if err != nil {
			return nil, err
		}
		if reject != nil {
			if err := reject(clean); err != nil {
				return nil, err
			}
		}
		if seen[clean] {
			continue
		}
		seen[clean] = true
		cleaned = append(cleaned, clean)
	}
	if len(cleaned) == 0 {
		return nil, fmt.Errorf("at least one path is required: %w", ErrValidation)
	}
	sort.Slice(cleaned, func(i, j int) bool {
		if strings.Count(cleaned[i], "/") != strings.Count(cleaned[j], "/") {
			return strings.Count(cleaned[i], "/") < strings.Count(cleaned[j], "/")
		}
		return cleaned[i] < cleaned[j]
	})
	pruned := cleaned[:0]
	for _, candidate := range cleaned {
		nested := false
		for _, parent := range pruned {
			if strings.HasPrefix(candidate, parent+"/") {
				nested = true
				break
			}
		}
		if !nested {
			pruned = append(pruned, candidate)
		}
	}
	return pruned, nil
}
